import { constants } from 'node:fs';
import { readdir, lstat, open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { counter, normalizeCounters, type AccountTokens, type ChatTokens, type Counters, type TokenSegment } from './tokens.ts';

export function validThreadId(id: unknown): id is string {
  return typeof id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id);
}
const ZERO: Counters = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const FIELDS = Object.keys(ZERO) as Array<keyof Counters>;
async function fileMarker(handle: FileHandle, offset: number): Promise<string | null> {
  if (!offset) return null;
  // Bounded fingerprints detect replacement/truncation followed by regrowth,
  // without retaining text from the start/end of the consumed file.
  const length = Math.min(offset, 512), first = Buffer.alloc(length), last = Buffer.alloc(length);
  await handle.read(first, 0, length, 0); await handle.read(last, 0, length, offset - length);
  return createHash('sha256').update(first).update(last).digest('hex');
}

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
  forkAmbiguous = false;
  private hasMetadata = false;
  private ordinal = 0;
  private ownStartOrdinal: number | null = null;
  private forked = false;
  private rawTotal: Counters | null = null;
  private inheritedTotal: Counters = { ...ZERO };

  skipRecord(): void { this.ordinal++; this.complete = false; }

  accept(line: string): void {
    const ordinal = this.ordinal++;
    if (!/"type"\s*:\s*"(token_count|turn_context|session_meta)"/.test(line)) return;
    let row: any; try { row = JSON.parse(line); } catch { this.complete = false; return; }
    if (row.type === 'session_meta') {
      // The first metadata belongs to this rollout. Copied fork history can
      // contain ancestors' metadata; it must never replace canonical ownership.
      if (this.hasMetadata) return;
      this.hasMetadata = true;
      this.sessionId = typeof row.payload?.id === 'string' ? row.payload.id : null;
      this.creatorAccountId = typeof row.payload?.creator_account_id === 'string' ? row.payload.creator_account_id : null;
      this.ownStartOrdinal = counter(row.payload?.subagent_history_start_ordinal);
      this.forked = row.payload?.forked_from_id != null || row.payload?.history_base != null || (this.ownStartOrdinal ?? 0) > 0;
      this.forkAmbiguous = this.forked && this.ownStartOrdinal === null;
      if (this.forkAmbiguous) this.complete = false;
    } else if (row.type === 'turn_context') {
      this.model = typeof row.payload?.model === 'string' ? row.payload.model.slice(0, 100) : null;
    } else if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info) {
      const info = row.payload.info;
      const next = normalizeCounters(info.total_token_usage);
      if (!next) { this.complete = false; return; }
      if (this.forkAmbiguous) return;
      if (this.forked && ordinal < this.ownStartOrdinal!) {
        this.rawTotal = next; this.inheritedTotal = next; return;
      }
      let previous = this.rawTotal ?? ZERO;
      const last = normalizeCounters(info.last_token_usage);
      // Equal nonzero counters at the child boundary could be either a replay
      // or a fresh request whose reset happens to equal the inherited request.
      // No local signal can distinguish them, so exclude this ambiguous fork.
      if (this.forked && this.total === null && previous.totalTokens > 0 && last &&
          FIELDS.every(field => next[field] === last[field] && next[field] === previous[field])) {
        this.forkAmbiguous = true; this.complete = false; return;
      }
      // A first own request can restart cumulative counters above or below the
      // inherited total. Equality with the last request proves a fresh counter;
      // an unchanged re-emission remains a no-op.
      if (this.forked && this.total === null && last && FIELDS.every(field => next[field] === last[field]) &&
          FIELDS.some(field => next[field] !== previous[field])) {
        previous = ZERO; this.inheritedTotal = { ...ZERO };
      }
      if (FIELDS.some(field => next[field] < previous[field])) {
        // Some forks restart their counters after copying inherited history.
        if (this.forked && this.total === null && FIELDS.every(field => next[field] <= previous[field])) {
          previous = ZERO; this.inheritedTotal = { ...ZERO };
        } else {
          this.complete = false; this.rawTotal = next;
          if (this.forked) { this.forkAmbiguous = true; this.total = null; }
          else this.total = next;
          return;
        }
      }
      const delta = Object.fromEntries(FIELDS.map(field => [field, next[field] - previous[field]])) as Counters;
      if (this.forked && this.total === null && delta.totalTokens !== 0 && (!last || FIELDS.some(field => delta[field] !== last[field]))) {
        this.forkAmbiguous = true; this.complete = false; return;
      }
      const ownTotal = Object.fromEntries(FIELDS.map(field => [field, next[field] - this.inheritedTotal[field]])) as Counters;
      if (delta.totalTokens === 0) {
        if (FIELDS.some(field => delta[field] !== 0)) { this.complete = false; this.total = ownTotal; this.rawTotal = next; }
        return;
      }
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
      this.segments.set(key, segment); this.total = ownTotal; this.rawTotal = next;
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
  private device: number | null = null;
  private marker: string | null = null;
  state = new TokenLogState();
  constructor(root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')) { this.root = root; }
  reset(id: string | null): void {
    this.id = id; this.path = null; this.offset = 0; this.inode = null; this.device = null; this.marker = null; this.state = new TokenLogState();
  }
  async find(path: string, id: string, depth = 0): Promise<string | null> {
    let entries; try {
      const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) return null;
      entries = await readdir(path, { withFileTypes: true });
    } catch { return null; }
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
      return await this.readPath(this.path, accountId, id);
    } catch { return { chat: null, errorCode: 'log_unavailable' }; }
  }
  async readPath(path: string, accountId: string, expectedId: string | null = null): Promise<{ chat: ChatTokens | null; errorCode: string | null }> {
    let handle;
    try {
      if (this.path !== path) { this.reset(expectedId); this.path = path; }
      const within = relative(resolve(this.root), resolve(path));
      if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Outside session root');
      let directory = resolve(this.root);
      for (const component of ['', ...dirname(within).split(sep).filter(part => part !== '.')]) {
        if (component) directory = join(directory, component);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked session directory');
      }
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Linked session file');
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || file.ino !== info.ino || file.dev !== info.dev) throw new Error('Session file changed');
      if (this.inode !== info.ino || this.device !== info.dev || info.size < this.offset ||
          (this.marker !== null && await fileMarker(handle, this.offset) !== this.marker)) {
        this.offset = 0; this.state = new TokenLogState(); this.inode = info.ino; this.device = info.dev; this.marker = null;
      }
      if (info.size > this.offset) {
        // Incremental JSONL parsing. Incomplete final records are reread next time.
        // Oversized unrelated records are skipped without retaining their contents.
        let position = this.offset, parts: Buffer[] = [], size = 0, skipped = false;
        for await (const chunk of handle.createReadStream({ start: this.offset, end: info.size - 1, autoClose: false })) {
          let start = 0;
          while (start < chunk.length) {
            const end = chunk.indexOf(10, start), stop = end === -1 ? chunk.length : end;
            const part = chunk.subarray(start, stop); size += part.length;
            if (size > 4_000_000) { skipped = true; parts = []; }
            else if (!skipped) parts.push(part);
            if (end === -1) break;
            if (!skipped) this.state.accept(Buffer.concat(parts, size).toString('utf8'));
            else this.state.skipRecord();
            this.offset = position + end + 1;
            parts = []; size = 0; skipped = false; start = end + 1;
          }
          position += chunk.length;
        }
      }
      this.marker = await fileMarker(handle, this.offset);
      if (!validThreadId(this.state.sessionId) || (expectedId !== null && this.state.sessionId !== expectedId) || this.state.creatorAccountId !== accountId) return { chat: null, errorCode: 'log_identity_mismatch' };
      if (this.state.forkAmbiguous) return { chat: null, errorCode: 'account_logs_incomplete' };
      const chat = this.state.snapshot(); return { chat, errorCode: chat ? null : 'no_token_events' };
    } catch {
      this.reset(this.id);
      return { chat: null, errorCode: 'log_unavailable' };
    } finally { await handle?.close(); }
  }
}

/** Account totals from verified local rollouts only; account/session IDs and
 * message contents never leave this reader. Every poll discovers new files. */
export class AccountTokenReader {
  root: string;
  private accountId: string | null = null;
  private readers = new Map<string, LocalTokenReader>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(root = process.env.CODEX_HOME ?? join(homedir(), '.codex')) { this.root = root; }
  read(accountId: string): Promise<{ account: AccountTokens | null; errorCode: string | null }> {
    const result = this.pending.catch(() => {}).then(() => this.readAccount(accountId));
    this.pending = result;
    return result;
  }
  private async discover(directory: string, files: string[], depth = 0): Promise<boolean> {
    let wasPresent = false;
    try {
      const info = await lstat(directory); wasPresent = true;
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      let incomplete = false;
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) incomplete = (depth >= 8 || await this.discover(path, files, depth + 1)) || incomplete;
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(path);
      }
      return incomplete;
    } catch (error: any) { return error?.code !== 'ENOENT' || wasPresent || depth > 0; }
  }
  private async readAccount(accountId: string): Promise<{ account: AccountTokens | null; errorCode: string | null }> {
    if (this.accountId !== accountId) { this.readers.clear(); this.accountId = accountId; }
    if (!accountId) return { account: null, errorCode: 'log_identity_mismatch' };
    const files: string[] = [];
    try {
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked Codex home');
    } catch { this.readers.clear(); return { account: null, errorCode: 'log_unavailable' }; }
    let incomplete = false;
    for (const directory of ['sessions', 'archived_sessions']) incomplete = await this.discover(join(this.root, directory), files) || incomplete;
    const available = new Set(files);
    for (const path of this.readers.keys()) if (!available.has(path)) this.readers.delete(path);
    const sessions = new Map<string, ChatTokens>();
    for (const path of files) {
      let reader = this.readers.get(path);
      if (!reader) { reader = new LocalTokenReader(this.root); this.readers.set(path, reader); }
      const result = await reader.readPath(path, accountId);
      if (result.errorCode === 'account_logs_incomplete' || result.errorCode === 'log_unavailable') incomplete = true;
      if (reader.state.creatorAccountId === accountId && !reader.state.complete) incomplete = true;
      if (!result.chat || !reader.state.sessionId) continue;
      const sessionId = reader.state.sessionId.toLowerCase(), previous = sessions.get(sessionId);
      // Active/archived copies and renamed rollouts share a canonical thread ID.
      // Keep one cumulative snapshot rather than summing the copies.
      if (!previous || result.chat.totalTokens > previous.totalTokens ||
          (result.chat.totalTokens === previous.totalTokens && result.chat.complete && !previous.complete)) sessions.set(sessionId, result.chat);
    }
    if (!sessions.size) return { account: null, errorCode: incomplete ? 'account_logs_incomplete' : 'no_token_events' };
    const account: AccountTokens = { ...ZERO, segments: [], updatedAtMs: null, complete: !incomplete, sessionCount: sessions.size };
    const segments = new Map<string, TokenSegment>();
    for (const chat of sessions.values()) {
      for (const field of FIELDS) {
        const value = counter(account[field] + chat[field]);
        if (value === null) return { account: null, errorCode: 'counter_overflow' };
        account[field] = value;
      }
      account.complete &&= chat.complete;
      if (chat.updatedAtMs !== null) account.updatedAtMs = Math.max(account.updatedAtMs ?? chat.updatedAtMs, chat.updatedAtMs);
      for (const segment of chat.segments) {
        const key = `${segment.model ?? 'unknown'}:${segment.longContext}`;
        const merged = segments.get(key) ?? { ...ZERO, model: segment.model, longContext: segment.longContext };
        for (const field of FIELDS) {
          const value = counter(merged[field] + segment[field]);
          if (value === null) return { account: null, errorCode: 'counter_overflow' };
          merged[field] = value;
        }
        segments.set(key, merged);
      }
    }
    account.segments = [...segments.values()];
    return { account, errorCode: incomplete ? 'account_logs_incomplete' : null };
  }
}
