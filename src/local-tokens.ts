import { constants } from 'node:fs';
import { readdir, lstat, open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { counter, normalizeCounters, type AccountTokens, type ChatTokens, type Counters, type TokenSegment, type TokenWindow, type WindowTokens } from './tokens.ts';

export function validThreadId(id: unknown): id is string {
  return typeof id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id);
}
const ZERO: Counters = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const FIELDS = Object.keys(ZERO) as Array<keyof Counters>;
type PeriodEntry = { atMs: number; segment: TokenSegment; sourceTotal: Counters; complete: boolean };
type PeriodSnapshot = ChatTokens & { excludedReviewTokens: number };
type PeriodUncertainty = { fromMs: number | null; toMs: number | null };
type AccountReadResult = { account: AccountTokens | null; errorCode: string | null; period: WindowTokens | null; periodErrorCode: string | null };
const MAX_PERIOD_ENTRIES = 20_000;
const MAX_PERIOD_UNCERTAINTIES = 256;
const FREE_REVIEW_MODEL = 'codex-auto-review';

type JsonFrame = { kind: 'object' | 'array'; expect: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd'; scope: 'root' | 'payload' | 'other'; key: 'type' | 'payload' | null };
/** Scans oversized records structurally without retaining message values.
 * Discriminators must be in the first 8 KiB. A later duplicate discriminator
 * invalidates an early header instead of overriding it silently. */
class OversizedRecordHeader {
  private frames: JsonFrame[] = [];
  private root: 'value' | 'done' = 'value';
  private mode: 'string' | 'number' | 'literal' | null = null;
  private bytes = 0;
  private invalid = false;
  private escaped = false;
  private unicodeRemaining = 0;
  private capture: number[] | null = null;
  private stringRole: 'key' | 'type' | 'other' = 'other';
  private stringScope: JsonFrame['scope'] = 'other';
  private numeric = '';
  private literal = '';
  private literalOffset = 0;
  private topType: string | null = null;
  private eventType: string | null = null;
  private typeKeys = 0;
  private payloadKeys = 0;
  private eventTypeKeys = 0;
  feed(chunk: Buffer): void {
    // Search unretained string bodies in native code. This keeps large image
    // and tool-output strings from paying a JavaScript call per payload byte.
    // Latin-1 gives one character per byte, so header offsets stay exact.
    const text = chunk.toString('latin1'), delimiters = /["\\\x00-\x1f]/g;
    let position = 0;
    while (position < chunk.length) {
      if (this.invalid) { this.bytes += chunk.length - position; return; }
      if (this.mode === 'string' && this.capture === null && !this.escaped && !this.unicodeRemaining) {
        delimiters.lastIndex = position;
        const boundary = delimiters.exec(text)?.index ?? chunk.length;
        this.bytes += boundary - position; position = boundary;
        if (position === chunk.length) return;
      }
      this.bytes++; this.consume(chunk[position++]);
    }
  }
  private finishNumber(): boolean { return ['zero', 'integer', 'fraction', 'exponentDigits'].includes(this.numeric); }
  private consume(byte: number): void {
    if (this.mode === 'string') {
      if (this.capture) { if (this.capture.length < 256) this.capture.push(byte); else this.capture = null; }
      if (this.unicodeRemaining) {
        if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))) this.invalid = true;
        else this.unicodeRemaining--;
        return;
      }
      if (this.escaped) {
        this.escaped = false;
        if (byte === 117) this.unicodeRemaining = 4;
        else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) this.invalid = true;
        return;
      }
      if (byte === 92) { this.escaped = true; return; }
      if (byte < 32) { this.invalid = true; return; }
      if (byte !== 34) return;
      this.mode = null;
      let value: string | null = null;
      if (this.capture) { try { value = JSON.parse(Buffer.from(this.capture).toString('utf8')); } catch { this.invalid = true; } }
      this.capture = null;
      const frame = this.frames.at(-1);
      if (this.stringRole === 'key' && frame) {
        frame.key = value === 'type' || value === 'payload' ? value : null; frame.expect = 'colon';
        if (frame.scope === 'root' && frame.key === 'type') this.typeKeys++;
        if (frame.scope === 'root' && frame.key === 'payload') this.payloadKeys++;
        if (frame.scope === 'payload' && frame.key === 'type') this.eventTypeKeys++;
      } else if (this.stringRole === 'type' && this.bytes <= 8_192) {
        if (this.stringScope === 'root') this.topType = value;
        else if (this.stringScope === 'payload') this.eventType = value;
      }
      return;
    }
    if (this.mode === 'literal') {
      if (byte !== this.literal.charCodeAt(this.literalOffset++)) { this.invalid = true; return; }
      if (this.literalOffset === this.literal.length) this.mode = null;
      return;
    }
    if (this.mode === 'number') {
      if (byte >= 48 && byte <= 57) {
        if (this.numeric === 'minus') this.numeric = byte === 48 ? 'zero' : 'integer';
        else if (this.numeric === 'zero') this.invalid = true;
        else if (this.numeric === 'dot') this.numeric = 'fraction';
        else if (this.numeric === 'exponent' || this.numeric === 'exponentSign') this.numeric = 'exponentDigits';
        return;
      }
      if (byte === 46 && (this.numeric === 'zero' || this.numeric === 'integer')) { this.numeric = 'dot'; return; }
      if ((byte === 101 || byte === 69) && ['zero', 'integer', 'fraction'].includes(this.numeric)) { this.numeric = 'exponent'; return; }
      if ((byte === 43 || byte === 45) && this.numeric === 'exponent') { this.numeric = 'exponentSign'; return; }
      if (!this.finishNumber()) { this.invalid = true; return; }
      this.mode = null;
    }
    if ([32, 9, 10, 13].includes(byte)) return;
    const frame = this.frames.at(-1);
    if (frame?.kind === 'object' && (frame.expect === 'keyOrEnd' || frame.expect === 'key')) {
      if (byte === 125 && frame.expect === 'keyOrEnd') { this.frames.pop(); return; }
      if (byte !== 34) { this.invalid = true; return; }
      this.mode = 'string'; this.stringRole = 'key'; this.stringScope = frame.scope;
      this.capture = frame.scope === 'other' ? null : [34]; return;
    }
    if (frame?.expect === 'colon') { if (byte !== 58) this.invalid = true; else frame.expect = 'value'; return; }
    if (frame?.expect === 'commaOrEnd') {
      if (byte === 44) { frame.expect = frame.kind === 'object' ? 'key' : 'value'; return; }
      if (byte === (frame.kind === 'object' ? 125 : 93)) { this.frames.pop(); return; }
      this.invalid = true; return;
    }
    if (frame?.kind === 'array' && frame.expect === 'valueOrEnd' && byte === 93) { this.frames.pop(); return; }
    if (!frame && this.root === 'done') { this.invalid = true; return; }
    const scope: JsonFrame['scope'] = !frame ? 'root' : frame.scope === 'root' && frame.key === 'payload' ? 'payload' : 'other';
    this.stringRole = frame?.key === 'type' && frame.scope !== 'other' ? 'type' : 'other';
    this.stringScope = frame?.scope ?? 'other';
    if (frame) frame.expect = 'commaOrEnd'; else this.root = 'done';
    if (byte === 123 || byte === 91) {
      if (this.frames.length >= 128) { this.invalid = true; return; }
      this.frames.push({ kind: byte === 123 ? 'object' : 'array', expect: byte === 123 ? 'keyOrEnd' : 'valueOrEnd', scope: byte === 123 ? scope : 'other', key: null }); return;
    }
    if (byte === 34) { this.mode = 'string'; this.capture = this.stringRole === 'type' ? [34] : null; return; }
    if (byte === 116 || byte === 102 || byte === 110) { this.mode = 'literal'; this.literal = byte === 116 ? 'true' : byte === 102 ? 'false' : 'null'; this.literalOffset = 1; return; }
    if (byte === 45 || (byte >= 48 && byte <= 57)) { this.mode = 'number'; this.numeric = byte === 45 ? 'minus' : byte === 48 ? 'zero' : 'integer'; return; }
    this.invalid = true;
  }
  finish(): { unrelated: boolean; clearModel: boolean } {
    const valid = !this.invalid && !this.frames.length && this.root === 'done' && (this.mode === null || (this.mode === 'number' && this.finishNumber())) && this.typeKeys === 1 && this.payloadKeys <= 1 && this.eventTypeKeys <= 1;
    const ordinaryEvent = this.topType === 'event_msg' && ['user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'item_completed', 'task_started', 'task_complete', 'turn_aborted'].includes(this.eventType ?? '');
    const unrelated = valid && (this.topType === 'response_item' || this.topType === 'compacted' || ordinaryEvent);
    return { unrelated, clearModel: !valid || this.topType === 'turn_context' || !['session_meta', 'event_msg', 'response_item', 'compacted'].includes(this.topType ?? '') };
  }
}

function aggregate(snapshots: ChatTokens[], incomplete = false): AccountTokens | null {
  const result: AccountTokens = { ...ZERO, segments: [], updatedAtMs: null, complete: !incomplete, sessionCount: snapshots.length };
  const segments = new Map<string, TokenSegment>();
  for (const snapshot of snapshots) {
    for (const field of FIELDS) {
      const value = counter(result[field] + snapshot[field]); if (value === null) return null;
      result[field] = value;
    }
    result.complete &&= snapshot.complete;
    if (snapshot.updatedAtMs !== null) result.updatedAtMs = Math.max(result.updatedAtMs ?? snapshot.updatedAtMs, snapshot.updatedAtMs);
    for (const segment of snapshot.segments) {
      const key = `${segment.model ?? 'unknown'}:${segment.longContext}`;
      const merged = segments.get(key) ?? { ...ZERO, model: segment.model, longContext: segment.longContext };
      for (const field of FIELDS) {
        const value = counter(merged[field] + segment[field]); if (value === null) return null;
        merged[field] = value;
      }
      segments.set(key, merged);
    }
  }
  result.segments = [...segments.values()]; return result;
}

function windowError(window: TokenWindow | null | undefined, now: number): string | null {
  if (!window || !Number.isSafeInteger(window.startAtMs) || !Number.isSafeInteger(window.endAtMs) ||
      window.startAtMs < 0 || window.endAtMs <= window.startAtMs || !Number.isSafeInteger(window.windowMinutes) || window.windowMinutes <= 0 ||
      window.endAtMs - window.startAtMs !== window.windowMinutes * 60_000 || !Number.isSafeInteger(now) || now < window.startAtMs) return 'window_unavailable';
  return now >= window.endAtMs ? 'window_expired' : null;
}
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
  private rawAtMs: number | null = null;
  periodRetainFromMs: number;
  private periodEntries: PeriodEntry[] = [];
  private periodUncertainties: PeriodUncertainty[] = [];
  private pendingUncertainties: PeriodUncertainty[] = [];

  constructor(retainFromMs = Infinity) { this.periodRetainFromMs = retainFromMs; }
  retainPeriodFrom(startAtMs: number): void {
    this.periodRetainFromMs = startAtMs;
    this.periodEntries = this.periodEntries.filter(entry => entry.atMs >= startAtMs);
    this.periodUncertainties = this.periodUncertainties.filter(gap => gap.toMs === null || gap.toMs >= startAtMs);
    this.pendingUncertainties = this.pendingUncertainties.filter(gap => this.periodUncertainties.includes(gap));
  }
  private uncertain(fromMs: number | null, toMs: number | null): void {
    if (fromMs !== null && toMs !== null && fromMs > toMs) { fromMs = null; toMs = null; }
    if (this.periodRetainFromMs === Infinity || (toMs !== null && toMs < this.periodRetainFromMs)) return;
    const gap = { fromMs, toMs }; this.periodUncertainties.push(gap);
    if (toMs === null) this.pendingUncertainties.push(gap);
    if (this.periodUncertainties.length > MAX_PERIOD_UNCERTAINTIES) {
      // Exhausted evidence is explicitly incomplete instead of silently dropped.
      const bounded = {
        fromMs: this.periodUncertainties.some(item => item.fromMs === null) ? null : Math.min(...this.periodUncertainties.map(item => item.fromMs!)),
        toMs: this.periodUncertainties.some(item => item.toMs === null) ? null : Math.max(...this.periodUncertainties.map(item => item.toMs!)),
      };
      this.periodUncertainties = [bounded]; this.pendingUncertainties = bounded.toMs === null ? [bounded] : [];
    }
  }
  private observeTime(atMs: number | null): void {
    if (atMs === null || !this.pendingUncertainties.length) return;
    for (const gap of this.pendingUncertainties) {
      if (gap.fromMs === null || gap.fromMs <= atMs) gap.toMs = atMs;
    }
    this.pendingUncertainties = this.pendingUncertainties.filter(gap => gap.toMs === null);
    this.retainPeriodFrom(this.periodRetainFromMs);
  }
  periodSnapshot(window: TokenWindow, now: number): PeriodSnapshot | null {
    const entries = this.periodEntries.filter(entry => entry.atMs >= window.startAtMs && entry.atMs < window.endAtMs && entry.atMs <= now);
    const incomplete = this.periodUncertainties.some(gap =>
      (gap.toMs === null || gap.toMs >= window.startAtMs) && (gap.fromMs === null || (gap.fromMs < window.endAtMs && gap.fromMs <= now)));
    let excludedReviewTokens = 0;
    const paid = entries.filter(entry => entry.segment.model !== FREE_REVIEW_MODEL);
    for (const entry of entries) if (entry.segment.model === FREE_REVIEW_MODEL) {
      const next = counter(excludedReviewTokens + entry.segment.totalTokens); if (next === null) return null;
      excludedReviewTokens = next;
    }
    const snapshot = aggregate(paid.map(entry => ({ ...entry.segment, segments: [{ ...entry.segment }], complete: entry.complete, updatedAtMs: entry.atMs })), incomplete);
    return snapshot ? { ...snapshot, excludedReviewTokens } : null;
  }
  periodEvidence(window: TokenWindow, now: number): Map<string, number> {
    const evidence = new Map<string, number>();
    for (const entry of this.periodEntries) {
      if (entry.atMs < window.startAtMs || entry.atMs >= window.endAtMs || entry.atMs > now) continue;
      // Copy conflicts in known free review events do not invalidate an exact
      // paid request. Cumulative parsing and ownership validation are unchanged.
      if (entry.segment.model === FREE_REVIEW_MODEL) continue;
      const key = createHash('sha256').update(JSON.stringify([entry.atMs, entry.segment.model, entry.segment.longContext,
        ...FIELDS.map(field => entry.segment[field]), ...FIELDS.map(field => entry.sourceTotal[field])])).digest('hex');
      evidence.set(key, (evidence.get(key) ?? 0) + 1);
    }
    return evidence;
  }

  skipRecord(unrelated = false, clearModel = true): void {
    this.ordinal++;
    if (unrelated) return;
    this.complete = false; if (clearModel) this.model = null;
    this.uncertain(this.rawAtMs, null);
  }

  accept(line: string): void {
    const ordinal = this.ordinal++;
    if (!/"type"\s*:\s*"(token_count|turn_context|session_meta)"/.test(line)) return;
    let row: any; try { row = JSON.parse(line); } catch { this.complete = false; this.uncertain(this.rawAtMs, null); return; }
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
      const parsedTime = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      const atMs = Number.isFinite(parsedTime) ? parsedTime : null;
      const next = normalizeCounters(info.total_token_usage);
      if (this.forked && ordinal < this.ownStartOrdinal!) {
        if (next) { this.rawTotal = next; this.inheritedTotal = next; this.rawAtMs = atMs; }
        return;
      }
      this.observeTime(atMs);
      if (!next) { this.complete = false; this.uncertain(atMs ?? this.rawAtMs, atMs); return; }
      if (this.forkAmbiguous) { this.uncertain(atMs ?? this.rawAtMs, atMs); return; }
      let previous = this.rawTotal ?? ZERO;
      const last = normalizeCounters(info.last_token_usage);
      // Equal nonzero counters at the child boundary could be either a replay
      // or a fresh request whose reset happens to equal the inherited request.
      // No local signal can distinguish them, so exclude this ambiguous fork.
      if (this.forked && this.total === null && previous.totalTokens > 0 && last &&
          FIELDS.every(field => next[field] === last[field] && next[field] === previous[field])) {
        this.forkAmbiguous = true; this.complete = false; this.uncertain(atMs ?? this.rawAtMs, atMs); return;
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
          this.uncertain(this.rawAtMs, atMs); this.rawAtMs = atMs;
          if (this.forked) { this.forkAmbiguous = true; this.total = null; }
          else this.total = next;
          return;
        }
      }
      const delta = Object.fromEntries(FIELDS.map(field => [field, next[field] - previous[field]])) as Counters;
      if (this.forked && this.total === null && delta.totalTokens !== 0 && (!last || FIELDS.some(field => delta[field] !== last[field]))) {
        this.forkAmbiguous = true; this.complete = false; this.uncertain(atMs ?? this.rawAtMs, atMs); return;
      }
      const ownTotal = Object.fromEntries(FIELDS.map(field => [field, next[field] - this.inheritedTotal[field]])) as Counters;
      if (delta.totalTokens === 0) {
        if (FIELDS.some(field => delta[field] !== 0)) { this.complete = false; this.total = ownTotal; this.rawTotal = next; this.uncertain(atMs ?? this.rawAtMs, atMs); this.rawAtMs = atMs; }
        return;
      }
      const requestInput = counter(info.last_token_usage?.input_tokens);
      const longContext = requestInput === null ? null : requestInput > 272_000;
      // A missing event could span multiple models or request lengths. Never
      // assign its cumulative gap to the last model and present a partial price.
      const exact = !!last && FIELDS.every(field => delta[field] === last[field]);
      const priced = !!this.model && exact &&
          counter(info.total_token_usage.cache_write_input_tokens) !== null &&
          counter(info.last_token_usage?.cache_write_input_tokens) !== null && longContext !== null;
      if (!this.model || !last || FIELDS.some(field => delta[field] !== last[field]) ||
          counter(info.total_token_usage.cache_write_input_tokens) === null ||
          counter(info.last_token_usage?.cache_write_input_tokens) === null || longContext === null) this.complete = false;
      const key = `${this.model ?? 'unknown'}:${longContext}`;
      const segment = this.segments.get(key) ?? { ...ZERO, model: this.model, longContext };
      for (const field of FIELDS) segment[field] += delta[field];
      this.segments.set(key, segment); this.total = ownTotal; this.rawTotal = next;
      if (!exact) this.uncertain(this.rawAtMs, atMs);
      // An undated event cannot inherit the previous row's lower time bound:
      // that timestamp may itself be in the future after a clock adjustment.
      else if (atMs === null && this.model !== FREE_REVIEW_MODEL) this.uncertain(null, null);
      else if (atMs !== null && atMs >= this.periodRetainFromMs) {
        this.periodEntries.push({ atMs, segment: { ...delta, model: this.model, longContext }, sourceTotal: { ...next }, complete: priced });
        if (this.periodEntries.length > MAX_PERIOD_ENTRIES) {
          const removed = this.periodEntries.splice(0, 1_000);
          this.uncertain(Math.min(...removed.map(entry => entry.atMs)), Math.max(...removed.map(entry => entry.atMs)));
        }
      }
      this.rawAtMs = atMs;
      this.updatedAtMs = atMs ?? this.updatedAtMs;
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
  private retainFromMs = Infinity;
  state = new TokenLogState();
  constructor(root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')) { this.root = root; }
  reset(id: string | null): void {
    this.id = id; this.path = null; this.offset = 0; this.inode = null; this.device = null; this.marker = null; this.state = new TokenLogState(this.retainFromMs);
  }
  preparePeriod(startAtMs: number): void {
    if (startAtMs < this.retainFromMs) {
      this.offset = 0; this.marker = null; this.state = new TokenLogState(startAtMs);
    } else this.state.retainPeriodFrom(startAtMs);
    this.retainFromMs = startAtMs;
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
        this.offset = 0; this.state = new TokenLogState(this.retainFromMs); this.inode = info.ino; this.device = info.dev; this.marker = null;
      }
      if (info.size > this.offset) {
        // Incremental JSONL parsing. Incomplete final records are reread next time.
        // Oversized unrelated records are skipped without retaining their contents.
        let position = this.offset, parts: Buffer[] = [], size = 0, skipped = false, header: OversizedRecordHeader | null = null;
        for await (const chunk of handle.createReadStream({ start: this.offset, end: info.size - 1, autoClose: false })) {
          let start = 0;
          while (start < chunk.length) {
            const end = chunk.indexOf(10, start), stop = end === -1 ? chunk.length : end;
            const part = chunk.subarray(start, stop); size += part.length;
            if (size > 4_000_000) {
              if (!skipped) { header = new OversizedRecordHeader(); for (const previousPart of parts) header.feed(previousPart); }
              header!.feed(part); skipped = true; parts = [];
            }
            else if (!skipped) parts.push(part);
            if (end === -1) break;
            if (!skipped) this.state.accept(Buffer.concat(parts, size).toString('utf8'));
            else { const classification = header!.finish(); this.state.skipRecord(classification.unrelated, classification.clearModel); }
            this.offset = position + end + 1;
            parts = []; size = 0; skipped = false; header = null; start = end + 1;
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
  read(accountId: string, window?: TokenWindow | null, now = Date.now()): Promise<AccountReadResult> {
    const requestedWindow = window ? { ...window } : window;
    const result = this.pending.catch(() => {}).then(() => this.readAccount(accountId, requestedWindow, now));
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
  private async readAccount(accountId: string, window: TokenWindow | null | undefined, now: number): Promise<AccountReadResult> {
    const periodErrorCode = windowError(window, now);
    const unavailable = (errorCode: string): AccountReadResult => ({ account: null, errorCode, period: null, periodErrorCode: periodErrorCode ?? errorCode });
    if (this.accountId !== accountId) { this.readers.clear(); this.accountId = accountId; }
    if (!accountId) return unavailable('log_identity_mismatch');
    const files: string[] = [];
    try {
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked Codex home');
    } catch { this.readers.clear(); return unavailable('log_unavailable'); }
    let incomplete = false;
    for (const directory of ['sessions', 'archived_sessions']) incomplete = await this.discover(join(this.root, directory), files) || incomplete;
    const available = new Set(files);
    for (const path of this.readers.keys()) if (!available.has(path)) this.readers.delete(path);
    const sessions = new Map<string, { chat: ChatTokens | null; reader: LocalTokenReader }>();
    const periodCopies = new Map<string, LocalTokenReader[]>();
    const discoveryIncomplete = incomplete;
    let unreadableFileIncomplete = false;
    for (const path of files) {
      let reader = this.readers.get(path);
      if (!reader) { reader = new LocalTokenReader(this.root); this.readers.set(path, reader); }
      if (!periodErrorCode) reader.preparePeriod(window!.startAtMs);
      const result = await reader.readPath(path, accountId);
      if (result.errorCode === 'log_unavailable') unreadableFileIncomplete = true;
      if (result.errorCode === 'account_logs_incomplete' || result.errorCode === 'log_unavailable') incomplete = true;
      if (reader.state.creatorAccountId === accountId && !reader.state.complete) incomplete = true;
      if (reader.state.creatorAccountId !== accountId || !validThreadId(reader.state.sessionId)) continue;
      const sessionId = reader.state.sessionId.toLowerCase(), previous = sessions.get(sessionId);
      const copies = periodCopies.get(sessionId) ?? []; copies.push(reader); periodCopies.set(sessionId, copies);
      // Active/archived copies and renamed rollouts share a canonical thread ID.
      // Keep one cumulative snapshot rather than summing the copies.
      const score = result.chat?.totalTokens ?? 0, previousScore = previous?.chat?.totalTokens ?? 0;
      if (!previous || score > previousScore ||
          (score === previousScore && result.chat?.complete && !previous.chat?.complete)) sessions.set(sessionId, { chat: result.chat, reader });
    }
    if (!sessions.size) return unavailable(incomplete ? 'account_logs_incomplete' : 'no_token_events');
    const chats = [...sessions.values()].flatMap(session => session.chat ? [session.chat] : []);
    const account = chats.length ? aggregate(chats, incomplete) : null;
    const errorCode = chats.length && !account ? 'counter_overflow' : incomplete ? 'account_logs_incomplete' : !chats.length ? 'no_token_events' : null;
    if (periodErrorCode) return { account, errorCode, period: null, periodErrorCode };
    const periods: ChatTokens[] = [];
    let excludedReviewTokens = 0;
    let periodIncomplete = discoveryIncomplete || unreadableFileIncomplete;
    for (const copies of periodCopies.values()) {
      const candidates = copies.map(reader => ({ reader, snapshot: reader.state.periodSnapshot(window!, now) }));
      if (candidates.some(candidate => !candidate.snapshot)) return { account, errorCode, period: null, periodErrorCode: 'counter_overflow' };
      candidates.sort((a, b) => b.snapshot!.totalTokens - a.snapshot!.totalTokens ||
        b.snapshot!.excludedReviewTokens - a.snapshot!.excludedReviewTokens || Number(b.snapshot!.complete) - Number(a.snapshot!.complete));
      const selected = candidates[0], snapshot = selected.snapshot!;
      // Keep one verified review subtotal per canonical session, including when
      // the fullest review copy differs from the fullest paid copy.
      const reviewSubtotal = Math.max(...candidates.map(candidate => candidate.snapshot!.excludedReviewTokens));
      const reviewTotal = counter(excludedReviewTokens + reviewSubtotal);
      if (reviewTotal === null) return { account, errorCode, period: null, periodErrorCode: 'counter_overflow' };
      excludedReviewTokens = reviewTotal;
      const evidence = selected.reader.state.periodEvidence(window!, now);
      for (const candidate of candidates) {
        periodIncomplete ||= !candidate.snapshot!.complete;
        if (candidate === selected || !candidate.snapshot!.totalTokens) continue;
        // A larger cumulative lifetime value need not contain a rewritten
        // current-period rollout. Verify current request evidence independently.
        for (const [key, occurrences] of candidate.reader.state.periodEvidence(window!, now)) {
          if ((evidence.get(key) ?? 0) < occurrences) { periodIncomplete = true; break; }
        }
      }
      if (snapshot.totalTokens > 0) periods.push(snapshot);
    }
    const summed = aggregate(periods, periodIncomplete);
    return { account, errorCode, period: summed ? { ...summed, excludedReviewTokens, window: { ...window! } } : null,
      periodErrorCode: !summed ? 'counter_overflow' : periodIncomplete ? 'period_logs_incomplete' : null };
  }
}
