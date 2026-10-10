import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { counter, normalizeCounters, type ChatTokens, type Counters, type TokenSegment } from './tokens.ts';

export function validThreadId(id: unknown): id is string {
  return typeof id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id);
}
const ZERO: Counters = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const FIELDS = Object.keys(ZERO) as Array<keyof Counters>;

/** Retains only session identity, model metadata and token_count counters.
 * Ordinary conversation records are skipped; contents are never published or logged. */
export class TokenLogState {
  sessionId: string | null = null;
  creatorAccountId: string | null = null;
  model: string | null = null;
  total: Counters | null = null;
  segments = new Map<string, TokenSegment>();
  complete = true;
  updatedAtMs: number | null = null;

  accept(line: string): void {
    if (!/"type"\s*:\s*"(token_count|turn_context|session_meta)"/.test(line)) return;
    let row: any; try { row = JSON.parse(line); } catch { return; }
    if (row.type === 'session_meta') {
      this.sessionId = typeof row.payload?.id === 'string' ? row.payload.id : null;
      this.creatorAccountId = typeof row.payload?.creator_account_id === 'string' ? row.payload.creator_account_id : null;
    } else if (row.type === 'turn_context') {
      this.model = typeof row.payload?.model === 'string' ? row.payload.model.slice(0, 100) : null;
    } else if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info) {
      const info = row.payload.info;
      const next = normalizeCounters(info.total_token_usage);
      if (!next) { this.complete = false; return; }
      const previous = this.total ?? ZERO;
      if (FIELDS.some(field => next[field] < previous[field])) { this.complete = false; this.total = next; return; }
      const delta = Object.fromEntries(FIELDS.map(field => [field, next[field] - previous[field]])) as Counters;
      if (delta.totalTokens === 0) {
        if (FIELDS.some(field => delta[field] !== 0)) { this.complete = false; this.total = next; }
        return;
      }
      const last = normalizeCounters(info.last_token_usage);
      const requestInput = counter(info.last_token_usage?.input_tokens);
      const longContext = requestInput === null ? null : requestInput > 272_000;
      // A missing event could span multiple models or request lengths. Never
      // assign its cumulative gap to the last model and present a partial price.
      if (!this.model || !last || FIELDS.some(field => delta[field] !== last[field]) ||
          counter(info.total_token_usage.cache_write_input_tokens) === null ||
          counter(info.last_token_usage?.cache_write_input_tokens) === null || longContext === null) this.complete = false;
      const key = `${this.model ?? 'unknown'}:${longContext}`;
      const segment = this.segments.get(key) ?? { ...ZERO, model: this.model, longContext };
      for (const field of FIELDS) segment[field] += delta[field];
      this.segments.set(key, segment); this.total = next;
      const timestamp = Date.parse(row.timestamp);
      this.updatedAtMs = Number.isFinite(timestamp) ? timestamp : this.updatedAtMs;
    }
  }
  snapshot(): ChatTokens | null {
    return this.total ? { ...this.total, segments: [...this.segments.values()].map(segment => ({ ...segment })), updatedAtMs: this.updatedAtMs, complete: this.complete } : null;
  }
}

export class LocalTokenReader {
  root: string;
  id: string | null = null;
  path: string | null = null;
  offset = 0;
  inode: number | null = null;
  state = new TokenLogState();
  constructor(root = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'), 'sessions')) { this.root = root; }
  reset(id: string | null): void {
    this.id = id; this.path = null; this.offset = 0; this.inode = null; this.state = new TokenLogState();
  }
  async find(path: string, id: string, depth = 0): Promise<string | null> {
    let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) return join(path, entry.name);
      if (entry.isDirectory() && depth < 4) {
        const result = await this.find(join(path, entry.name), id, depth + 1); if (result) return result;
      }
    }
    return null;
  }
  async read(id: string | null, accountId: string): Promise<{ chat: ChatTokens | null; errorCode: string | null }> {
    if (!validThreadId(id)) return { chat: null, errorCode: 'no_tracked_thread' };
    if (this.id !== id) this.reset(id);
    try {
      if (!this.path) this.path = await this.find(this.root, id);
      if (!this.path) return { chat: null, errorCode: 'log_unavailable' };
      const info = await stat(this.path);
      if (!info.isFile()) return { chat: null, errorCode: 'log_unavailable' };
      if (this.inode !== info.ino || info.size < this.offset) { this.offset = 0; this.state = new TokenLogState(); this.inode = info.ino; }
      if (info.size > this.offset) {
        // Incremental JSONL parsing. Incomplete final records are reread next time.
        // Oversized unrelated records are skipped without retaining their contents.
        let position = this.offset, parts: Buffer[] = [], size = 0, skipped = false;
        for await (const chunk of createReadStream(this.path, { start: this.offset, end: info.size - 1 })) {
          let start = 0;
          while (start < chunk.length) {
            const end = chunk.indexOf(10, start), stop = end === -1 ? chunk.length : end;
            const part = chunk.subarray(start, stop); size += part.length;
            if (size > 4_000_000) { skipped = true; parts = []; }
            else if (!skipped) parts.push(part);
            if (end === -1) break;
            if (!skipped) this.state.accept(Buffer.concat(parts, size).toString('utf8'));
            this.offset = position + end + 1;
            parts = []; size = 0; skipped = false; start = end + 1;
          }
          position += chunk.length;
        }
      }
      if (this.state.sessionId !== id || this.state.creatorAccountId !== accountId) return { chat: null, errorCode: 'log_identity_mismatch' };
      const chat = this.state.snapshot(); return { chat, errorCode: chat ? null : 'no_token_events' };
    } catch {
      this.path = null; this.offset = 0; this.inode = null; this.state = new TokenLogState();
      return { chat: null, errorCode: 'log_unavailable' };
    }
  }
}
