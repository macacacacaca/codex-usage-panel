import { constants } from 'node:fs';
import { readdir, lstat, open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { counter, normalizeCounters, type AccountTokens, type ChatTokens, type Counters, type TokenSegment, type TokenWindow, type WindowTokens } from './tokens.ts';

export function validThreadId(id: unknown): id is string {
  return typeof id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id);
}
const ZERO: Counters = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const FIELDS = Object.keys(ZERO) as Array<keyof Counters>;
type PeriodEntry = { atMs: number; segment: TokenSegment; sourceTotal: Counters; complete: boolean };
type PeriodSnapshot = ChatTokens & { excludedReviewTokens: number };
type PeriodUncertainty = { fromMs: number | null; toMs: number | null; inheritedPrefix?: boolean };
type AccountReadResult = { account: AccountTokens | null; errorCode: string | null; period: WindowTokens | null; periodErrorCode: string | null };
const MAX_PERIOD_ENTRIES = 20_000;
const MAX_PERIOD_UNCERTAINTIES = 256;
const FREE_REVIEW_MODEL = 'codex-auto-review';
const MAX_REFERENCE_DEPTH = 32;
type HistoryReference = { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number };
type ReferenceBaseline = { reference: HistoryReference; total: Counters; atMs: number | null; signature: string; canonicalId: string; physicalIds: string[] };
type ReferenceResolver = (metadata: any) => Promise<ReferenceBaseline | null>;

function historyReference(value: any): HistoryReference | null {
  return value && validThreadId(value.thread_id) && Number.isSafeInteger(value.end_ordinal_exclusive) && value.end_ordinal_exclusive > 0 &&
    Number.isSafeInteger(value.end_byte_offset) && value.end_byte_offset > 0
    ? { thread_id: value.thread_id.toLowerCase(), end_ordinal_exclusive: value.end_ordinal_exclusive, end_byte_offset: value.end_byte_offset } : null;
}
function physicalRolloutId(path: string): string | null {
  const match = basename(path).match(/(?:-|_)([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.jsonl$/i);
  return match?.[1].toLowerCase() ?? null;
}
function canonicalRolloutId(path: string): string | null {
  const uuid = '[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}';
  return basename(path).match(new RegExp(`-(${uuid})(?:_${uuid})?\\.jsonl$`, 'i'))?.[1].toLowerCase() ?? null;
}
function selectedMetadata(row: any) {
  const value = row?.payload, base = value?.history_base;
  return { type: 'session_meta', ordinal: typeof row?.ordinal === 'number' ? row.ordinal : null, payload: {
    id: typeof value?.id === 'string' ? value.id : null,
    creator_account_id: typeof value?.creator_account_id === 'string' ? value.creator_account_id : null,
    history_mode: typeof value?.history_mode === 'string' ? value.history_mode : null,
    history_base: base == null ? null : { thread_id: typeof base.thread_id === 'string' ? base.thread_id : null,
      end_ordinal_exclusive: typeof base.end_ordinal_exclusive === 'number' ? base.end_ordinal_exclusive : null,
      end_byte_offset: typeof base.end_byte_offset === 'number' ? base.end_byte_offset : null },
    forked_from_id: value?.forked_from_id == null ? null : typeof value.forked_from_id === 'string' ? value.forked_from_id : false,
    subagent_history_start_ordinal: value?.subagent_history_start_ordinal == null ? null :
      typeof value.subagent_history_start_ordinal === 'number' ? value.subagent_history_start_ordinal : false,
  } };
}

type JsonFrame = { kind: 'object' | 'array'; expect: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd'; scope: 'root' | 'payload' | 'other'; key: 'type' | 'payload' | 'ordinal' | null };
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
  private ordinalKeys = 0;
  private ordinalValue: number | null = null;
  private ordinalNumber: string | null = null;
  private readingOrdinal = false;
  private finishOrdinal(): void {
    if (this.readingOrdinal && this.ordinalNumber !== null) {
      const value = Number(this.ordinalNumber);
      if (Number.isSafeInteger(value) && value >= 0) this.ordinalValue = value;
    }
    this.readingOrdinal = false; this.ordinalNumber = null;
  }
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
        frame.key = value === 'type' || value === 'payload' || value === 'ordinal' ? value : null; frame.expect = 'colon';
        if (frame.scope === 'root' && frame.key === 'type') this.typeKeys++;
        if (frame.scope === 'root' && frame.key === 'payload') this.payloadKeys++;
        if (frame.scope === 'payload' && frame.key === 'type') this.eventTypeKeys++;
        if (frame.scope === 'root' && frame.key === 'ordinal') this.ordinalKeys++;
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
      if (this.readingOrdinal && /[\d.eE+-]/.test(String.fromCharCode(byte))) {
        this.ordinalNumber = this.ordinalNumber !== null && this.ordinalNumber.length < 32 ? this.ordinalNumber + String.fromCharCode(byte) : null;
      }
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
      this.finishOrdinal();
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
    if (byte === 45 || (byte >= 48 && byte <= 57)) {
      this.mode = 'number'; this.numeric = byte === 45 ? 'minus' : byte === 48 ? 'zero' : 'integer';
      this.readingOrdinal = frame?.scope === 'root' && frame.key === 'ordinal';
      this.ordinalNumber = this.readingOrdinal ? String.fromCharCode(byte) : null; return;
    }
    this.invalid = true;
  }
  finish(): { unrelated: boolean; clearModel: boolean; boundaryExcluded: boolean; valid: boolean; type: string | null; eventType: string | null; ordinal: number | null } {
    if (this.mode === 'number' && this.finishNumber()) this.finishOrdinal();
    const valid = !this.invalid && !this.frames.length && this.root === 'done' && (this.mode === null || (this.mode === 'number' && this.finishNumber())) && this.typeKeys === 1 && this.payloadKeys <= 1 && this.eventTypeKeys <= 1 && this.ordinalKeys <= 1;
    const ordinaryEvent = this.topType === 'event_msg' && ['user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'item_completed', 'task_started', 'task_complete', 'turn_aborted'].includes(this.eventType ?? '');
    const unrelated = valid && (this.topType === 'response_item' || this.topType === 'compacted' || ordinaryEvent);
    // Official RolloutItem variants have distinct root tags; their nested
    // values cannot replace an event_msg thread-settings ownership marker.
    const boundaryExcluded = valid && (['session_meta', 'turn_context', 'response_item', 'compacted', 'world_state',
      'inter_agent_communication', 'inter_agent_communication_metadata', 'token_usage_record', 'retained_context',
      'security_risk_score', 'realtime_item'].includes(this.topType ?? '') ||
      this.topType === 'event_msg' && this.eventType !== null && this.eventType !== 'thread_settings_applied');
    return { unrelated, boundaryExcluded, valid, type: this.topType, eventType: this.eventType, ordinal: this.ordinalValue,
      clearModel: !valid || this.topType === 'turn_context' || !['session_meta', 'event_msg', 'response_item', 'compacted'].includes(this.topType ?? '') };
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

async function openRollout(root: string, path: string) {
  const within = relative(resolve(root), resolve(path));
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Outside session root');
  let directory = resolve(root);
  for (const component of ['', ...dirname(within).split(sep).filter(part => part !== '.')]) {
    if (component) directory = join(directory, component);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked session directory');
  }
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Linked session file');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || file.ino !== info.ino || file.dev !== info.dev) throw new Error('Session file changed');
    return { handle, info };
  } catch (error) { await handle.close(); throw error; }
}

async function canonicalMetadata(handle: FileHandle): Promise<any | null> {
  const parts: Buffer[] = []; let size = 0, position = 0;
  while (size <= 4_000_000) {
    const buffer = Buffer.alloc(65_536), { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return null;
    const end = buffer.subarray(0, bytesRead).indexOf(10), part = buffer.subarray(0, end === -1 ? bytesRead : end);
    parts.push(part); size += part.length; position += bytesRead;
    if (size > 4_000_000) return null;
    if (end !== -1) {
      try { const row = JSON.parse(Buffer.concat(parts, size).toString('utf8')); return row.type === 'session_meta' ? selectedMetadata(row) : null; }
      catch { return null; }
    }
  }
  return null;
}

/** Read only the byte/ordinal prefix actually referenced by another rollout.
 * Message values are never retained, and the prefix contributes no child use. */
async function referencePrefix(root: string, path: string, reference: HistoryReference, accountId: string,
  resolveParent: (metadata: any) => Promise<ReferenceBaseline | null>): Promise<ReferenceBaseline> {
  if (physicalRolloutId(path) !== reference.thread_id) throw new Error('Physical reference mismatch');
  const { handle, info } = await openRollout(root, path);
  try {
    if (info.size < reference.end_byte_offset) throw new Error('Truncated reference');
    const lastByte = Buffer.alloc(1); await handle.read(lastByte, 0, 1, reference.end_byte_offset - 1);
    if (lastByte[0] !== 10) throw new Error('Partial reference record');
    const digest = createHash('sha256'); let metadata: any = null, parent: ReferenceBaseline | null = null;
    let total = { ...ZERO }, atMs: number | null = null, expectedOrdinal: number | null = null;
    let parts: Buffer[] = [], size = 0, header = new OversizedRecordHeader();
    for await (const chunk of handle.createReadStream({ start: 0, end: reference.end_byte_offset - 1, autoClose: false })) {
      digest.update(chunk); let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start), stop = end === -1 ? chunk.length : end, part = chunk.subarray(start, stop);
        header.feed(part); size += part.length;
        if (size <= 4_000_000) parts.push(part); else parts = [];
        if (end === -1) break;
        const classification = header.finish();
        if (!classification.valid || classification.ordinal === null) throw new Error('Invalid reference ordinal');
        if (metadata === null) {
          if (classification.type !== 'session_meta' || size > 4_000_000) throw new Error('Missing reference metadata');
          metadata = selectedMetadata(JSON.parse(Buffer.concat(parts, size).toString('utf8'))).payload;
          if (!validThreadId(metadata?.id) || canonicalRolloutId(path) !== metadata.id.toLowerCase() || metadata.creator_account_id !== accountId || metadata.history_mode !== 'paginated') throw new Error('Reference ownership mismatch');
          if (metadata.history_base != null) {
            if (!historyReference(metadata.history_base)) throw new Error('Invalid ancestor reference');
            parent = await resolveParent(metadata); if (!parent) throw new Error('Unavailable ancestor');
            total = { ...parent.total }; atMs = parent.atMs;
          }
          expectedOrdinal = parent?.reference.end_ordinal_exclusive ?? 0;
        }
        if (classification.ordinal !== expectedOrdinal || expectedOrdinal >= reference.end_ordinal_exclusive) throw new Error('Noncontiguous reference ordinal');
        expectedOrdinal++;
        if (classification.type === 'event_msg' && classification.eventType === 'token_count') {
          if (size > 4_000_000) throw new Error('Unreadable reference counters');
          const row = JSON.parse(Buffer.concat(parts, size).toString('utf8'));
          if (row.payload.info != null) {
            const next = normalizeCounters(row.payload.info.total_token_usage); if (!next) throw new Error('Invalid reference counters');
            total = next;
            const parsed = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
            atMs = Number.isFinite(parsed) ? parsed : null;
          }
        } else if (!classification.boundaryExcluded && !(classification.type === 'event_msg' && classification.eventType === 'thread_settings_applied')) {
          throw new Error('Unknown reference record');
        }
        parts = []; size = 0; header = new OversizedRecordHeader(); start = end + 1;
      }
    }
    if (size || metadata === null || expectedOrdinal !== reference.end_ordinal_exclusive) throw new Error('Reference cutoff mismatch');
    const after = await handle.stat();
    if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('Reference changed during read');
    return { reference, total, atMs, canonicalId: metadata.id.toLowerCase(), physicalIds: [reference.thread_id, ...(parent?.physicalIds ?? [])],
      signature: createHash('sha256').update(digest.digest()).update(parent?.signature ?? '').digest('hex') };
  } finally { await handle.close(); }
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
  referenceHistoryVerified = false;
  paginatedHistoryVerified = false;
  referenceHistoryUnavailable = false;
  private referenceBaseline: ReferenceBaseline | null = null;
  private hasMetadata = false;
  private ordinal = 0;
  private ownStartOrdinal: number | null = null;
  private forked = false;
  private awaitingLegacyForkBoundary = false;
  private legacyForkBoundaryUnsafe = false;
  private completeBeforeInheritedPrefix = true;
  private rawTotal: Counters | null = null;
  private inheritedTotal: Counters = { ...ZERO };
  private rawAtMs: number | null = null;
  periodRetainFromMs: number;
  private periodEntries: PeriodEntry[] = [];
  private periodUncertainties: PeriodUncertainty[] = [];
  private pendingUncertainties: PeriodUncertainty[] = [];

  constructor(retainFromMs = Infinity) { this.periodRetainFromMs = retainFromMs; }
  prepareReference(baseline: ReferenceBaseline | null): void { this.referenceBaseline = baseline; }
  retainPeriodFrom(startAtMs: number): void {
    this.periodRetainFromMs = startAtMs;
    this.periodEntries = this.periodEntries.filter(entry => entry.atMs >= startAtMs);
    this.periodUncertainties = this.periodUncertainties.filter(gap => gap.toMs === null || gap.toMs >= startAtMs);
    this.pendingUncertainties = this.pendingUncertainties.filter(gap => this.periodUncertainties.includes(gap));
  }
  private uncertain(fromMs: number | null, toMs: number | null): void {
    if (fromMs !== null && toMs !== null && fromMs > toMs) { fromMs = null; toMs = null; }
    if (this.periodRetainFromMs === Infinity || (toMs !== null && toMs < this.periodRetainFromMs)) return;
    const gap: PeriodUncertainty = { fromMs, toMs, inheritedPrefix: this.awaitingLegacyForkBoundary }; this.periodUncertainties.push(gap);
    if (toMs === null) this.pendingUncertainties.push(gap);
    if (this.periodUncertainties.length > MAX_PERIOD_UNCERTAINTIES) {
      // Exhausted evidence is explicitly incomplete instead of silently dropped.
      const bounded = {
        fromMs: this.periodUncertainties.some(item => item.fromMs === null) ? null : Math.min(...this.periodUncertainties.map(item => item.fromMs!)),
        toMs: this.periodUncertainties.some(item => item.toMs === null) ? null : Math.max(...this.periodUncertainties.map(item => item.toMs!)),
        inheritedPrefix: this.periodUncertainties.every(item => item.inheritedPrefix),
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

  skipRecord(unrelated = false, clearModel = true, recordedOrdinal: number | null = null): void {
    if (this.paginatedHistoryVerified && recordedOrdinal !== this.ordinal) {
      this.complete = false; this.forkAmbiguous = true; this.uncertain(this.rawAtMs, null);
    }
    this.ordinal++;
    if (unrelated) return;
    // A skipped relevant record could hide the first child-owned marker. A
    // later resume marker cannot safely reclassify the intervening requests.
    if (this.awaitingLegacyForkBoundary) this.legacyForkBoundaryUnsafe = true;
    this.complete = false; if (clearModel) this.model = null;
    this.uncertain(this.rawAtMs, null);
  }

  private validateLegacyPrefix(line: string): void {
    if (!this.awaitingLegacyForkBoundary || !line.trim()) return;
    // Ordinary prefix rows need no retained values, but malformed or unknown
    // headers could conceal the child's initial settings marker.
    const header = new OversizedRecordHeader(); header.feed(Buffer.from(line));
    if (!header.finish().boundaryExcluded) {
      this.legacyForkBoundaryUnsafe = true; this.complete = false; this.uncertain(this.rawAtMs, null);
    }
  }

  accept(line: string): void {
    if (this.paginatedHistoryVerified) {
      const header = new OversizedRecordHeader(); header.feed(Buffer.from(line)); const classification = header.finish();
      if (!classification.valid || classification.ordinal !== this.ordinal) {
        this.ordinal++; this.complete = false; this.forkAmbiguous = true; this.uncertain(this.rawAtMs, null); return;
      }
    }
    const ordinal = this.ordinal++;
    if (!/"type"\s*:\s*"(token_count|turn_context|session_meta|thread_settings_applied)"/.test(line)) {
      this.validateLegacyPrefix(line);
      return;
    }
    let row: any; try { row = JSON.parse(line); } catch {
      if (this.awaitingLegacyForkBoundary) this.legacyForkBoundaryUnsafe = true;
      this.complete = false; this.uncertain(this.rawAtMs, null); return;
    }
    if (row.type === 'session_meta') {
      // The first metadata belongs to this rollout. Copied fork history can
      // contain ancestors' metadata; it must never replace canonical ownership.
      if (this.hasMetadata) return;
      this.hasMetadata = true;
      this.sessionId = typeof row.payload?.id === 'string' ? row.payload.id : null;
      this.creatorAccountId = typeof row.payload?.creator_account_id === 'string' ? row.payload.creator_account_id : null;
      if (row.payload?.history_mode === 'paginated' && row.payload?.history_base == null) {
        const header = new OversizedRecordHeader(); header.feed(Buffer.from(line));
        const classification = header.finish();
        if (ordinal === 0 && classification.valid && classification.ordinal === 0) this.paginatedHistoryVerified = true;
        else { this.complete = false; this.forkAmbiguous = true; this.uncertain(null, null); }
      }
      this.ownStartOrdinal = counter(row.payload?.subagent_history_start_ordinal);
      this.forked = row.payload?.forked_from_id != null || row.payload?.history_base != null || (this.ownStartOrdinal ?? 0) > 0;
      this.forkAmbiguous ||= this.forked && this.ownStartOrdinal === null;
      if (row.payload?.history_base != null) {
        const reference = historyReference(row.payload.history_base), baseline = this.referenceBaseline;
        const header = new OversizedRecordHeader(); header.feed(Buffer.from(line)); const classification = header.finish();
        if (ordinal === 0 && classification.valid && classification.ordinal === reference?.end_ordinal_exclusive && reference && baseline && row.payload.history_mode === 'paginated' && row.ordinal === reference.end_ordinal_exclusive &&
          (row.payload.subagent_history_start_ordinal == null || this.ownStartOrdinal !== null) &&
          JSON.stringify(reference) === JSON.stringify(baseline.reference) && Number.isSafeInteger(reference.end_ordinal_exclusive + 1)) {
          this.referenceHistoryVerified = true; this.paginatedHistoryVerified = true; this.forkAmbiguous = false;
          this.rawTotal = { ...baseline.total }; this.inheritedTotal = { ...baseline.total }; this.rawAtMs = baseline.atMs;
          this.ordinal = reference.end_ordinal_exclusive + 1;
          this.ownStartOrdinal = Math.max(this.ownStartOrdinal ?? this.ordinal, this.ordinal);
        } else { this.referenceHistoryUnavailable = true; this.forkAmbiguous = true; this.complete = false; this.ownStartOrdinal = null; }
      }
      this.awaitingLegacyForkBoundary = this.forkAmbiguous && validThreadId(this.sessionId) && validThreadId(row.payload?.forked_from_id) &&
        row.payload.forked_from_id.toLowerCase() !== this.sessionId.toLowerCase() &&
        row.payload?.history_base == null && row.payload?.subagent_history_start_ordinal == null &&
        (row.payload?.history_mode == null || row.payload.history_mode === 'legacy');
      this.completeBeforeInheritedPrefix = this.complete;
      if (this.forkAmbiguous) this.complete = false;
    } else if (row.type === 'turn_context') {
      this.model = typeof row.payload?.model === 'string' ? row.payload.model.slice(0, 100) : null;
    } else if (this.awaitingLegacyForkBoundary && row.type === 'event_msg' && row.payload?.type === 'thread_settings_applied') {
      if (!validThreadId(row.payload.thread_id)) { this.legacyForkBoundaryUnsafe = true; return; }
      if (this.legacyForkBoundaryUnsafe || !validThreadId(this.sessionId) ||
        row.payload.thread_id.toLowerCase() !== this.sessionId.toLowerCase()) return;
      // Copied legacy forks append their own settings after inherited history.
      // Parent-owned settings cannot establish this boundary, and subsequent
      // settings must never erase uncertainty from the child's real requests.
      this.awaitingLegacyForkBoundary = false; this.forkAmbiguous = false;
      this.ownStartOrdinal = ordinal + 1; this.complete = this.completeBeforeInheritedPrefix;
      this.periodUncertainties = this.periodUncertainties.filter(gap => !gap.inheritedPrefix);
      this.pendingUncertainties = this.pendingUncertainties.filter(gap => this.periodUncertainties.includes(gap));
      const model = row.payload.thread_settings?.model;
      this.model = typeof model === 'string' && model.trim() ? model.slice(0, 100) : null;
    } else if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.info) {
      const info = row.payload.info;
      const parsedTime = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      const atMs = Number.isFinite(parsedTime) ? parsedTime : null;
      const next = normalizeCounters(info.total_token_usage);
      if (this.forked && ordinal < this.ownStartOrdinal!) {
        if (next) { this.rawTotal = next; this.inheritedTotal = next; this.rawAtMs = atMs; }
        return;
      }
      if (this.awaitingLegacyForkBoundary) {
        const previousAtMs = this.rawAtMs;
        if (next) { this.rawTotal = next; this.inheritedTotal = next; this.rawAtMs = atMs; }
        // Keep unresolved prefixes incomplete until their ownership is proven.
        // Their counters seed reconciliation, but are never counted as child use.
        this.uncertain(atMs ?? previousAtMs, atMs); return;
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
    } else this.validateLegacyPrefix(line);
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
  private referenceSignature: string | null = null;
  referencePhysicalIds: string[] = [];
  physicalId: string | null = null;
  private retainFromMs = Infinity;
  state = new TokenLogState();
  constructor(root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')) { this.root = root; }
  reset(id: string | null): void {
    this.id = id; this.path = null; this.offset = 0; this.inode = null; this.device = null; this.marker = null; this.referenceSignature = null; this.referencePhysicalIds = []; this.physicalId = null; this.state = new TokenLogState(this.retainFromMs);
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
  async readPath(path: string, accountId: string, expectedId: string | null = null, resolveReference?: ReferenceResolver): Promise<{ chat: ChatTokens | null; errorCode: string | null }> {
    let handle;
    try {
      if (this.path !== path) { this.reset(expectedId); this.path = path; }
      const opened = await openRollout(this.root, path); handle = opened.handle; const info = opened.info;
      if (this.inode !== info.ino || this.device !== info.dev || info.size < this.offset ||
          (this.marker !== null && await fileMarker(handle, this.offset) !== this.marker)) {
        this.offset = 0; this.state = new TokenLogState(this.retainFromMs); this.inode = info.ino; this.device = info.dev; this.marker = null;
      }
      const metadata = await canonicalMetadata(handle);
      const referenced = metadata?.payload?.history_base != null;
      const filenameVerified = validThreadId(metadata?.payload?.id) && canonicalRolloutId(path) === metadata.payload.id.toLowerCase();
      const baseline = referenced && filenameVerified && metadata.payload.creator_account_id === accountId && resolveReference
        ? await resolveReference(metadata.payload) : null;
      const signature = referenced ? `${baseline?.signature ?? 'unavailable'}:${JSON.stringify(historyReference(metadata.payload.history_base))}` : null;
      if (signature !== this.referenceSignature) {
        this.offset = 0; this.marker = null; this.state = new TokenLogState(this.retainFromMs); this.referenceSignature = signature;
      }
      if (!this.offset) this.state.prepareReference(baseline);
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
            else { const classification = header!.finish(); this.state.skipRecord(classification.unrelated, classification.clearModel, classification.valid ? classification.ordinal : null); }
            this.offset = position + end + 1;
            parts = []; size = 0; skipped = false; header = null; start = end + 1;
          }
          position += chunk.length;
        }
      }
      this.referencePhysicalIds = this.state.referenceHistoryVerified ? baseline?.physicalIds ?? [] : [];
      this.physicalId = filenameVerified && this.state.paginatedHistoryVerified ? physicalRolloutId(path) : null;
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
    const physicalFiles = new Map<string, string[]>();
    for (const path of files) {
      const physicalId = physicalRolloutId(path); if (!physicalId) continue;
      const copies = physicalFiles.get(physicalId) ?? []; copies.push(path); physicalFiles.set(physicalId, copies);
    }
    // Only discovered physical IDs can be resolved. Successful bounded prefixes
    // are shared within this poll, and rehashed on the next poll.
    const resolvedPrefixes = new Map<string, ReferenceBaseline>();
    const resolveReference = async (metadata: any, visited: Set<string>): Promise<ReferenceBaseline | null> => {
      const reference = historyReference(metadata.history_base);
      if (!reference || metadata.history_mode !== 'paginated' || metadata.creator_account_id !== accountId ||
          visited.has(reference.thread_id) || visited.size >= MAX_REFERENCE_DEPTH || !validThreadId(metadata.id) ||
          metadata.forked_from_id != null && !validThreadId(metadata.forked_from_id)) return null;
      const matchesOwner = (baseline: ReferenceBaseline) => baseline.canonicalId === metadata.id.toLowerCase() ||
        validThreadId(metadata.forked_from_id) && baseline.canonicalId === metadata.forked_from_id.toLowerCase();
      const key = JSON.stringify(reference), cached = resolvedPrefixes.get(key);
      if (cached) return visited.size + cached.physicalIds.length > MAX_REFERENCE_DEPTH || cached.physicalIds.some(id => visited.has(id)) || !matchesOwner(cached) ? null : cached;
      const paths = physicalFiles.get(reference.thread_id); if (!paths?.length) return null;
      const ancestors = new Set(visited); ancestors.add(reference.thread_id);
      let baseline: ReferenceBaseline | null = null;
      for (const path of paths) {
        try {
          const candidate = await referencePrefix(this.root, path, reference, accountId, parent => resolveReference(parent, ancestors));
          if (baseline && (candidate.signature !== baseline.signature || candidate.canonicalId !== baseline.canonicalId)) return null;
          baseline = candidate;
        } catch { return null; }
      }
      if (baseline) resolvedPrefixes.set(key, baseline);
      return baseline && matchesOwner(baseline) ? baseline : null;
    };
    type ReadCopy = { chat: ChatTokens | null; reader: LocalTokenReader };
    const sessions = new Map<string, ReadCopy[]>();
    const trustedPhysicalIds = new Set<string>();
    const discoveryIncomplete = incomplete;
    let unreadableFileIncomplete = false;
    for (const path of files) {
      let reader = this.readers.get(path);
      if (!reader) { reader = new LocalTokenReader(this.root); this.readers.set(path, reader); }
      if (!periodErrorCode) reader.preparePeriod(window!.startAtMs);
      const physicalId = physicalRolloutId(path);
      const result = await reader.readPath(path, accountId, null,
        metadata => resolveReference(metadata, new Set(physicalId ? [physicalId] : [])));
      if (result.errorCode === 'log_unavailable') unreadableFileIncomplete = true;
      if (result.errorCode === 'account_logs_incomplete' || result.errorCode === 'log_unavailable') incomplete = true;
      if (reader.state.creatorAccountId === accountId && !reader.state.complete) incomplete = true;
      if (reader.state.creatorAccountId !== accountId || !validThreadId(reader.state.sessionId)) continue;
      const sessionId = reader.state.sessionId.toLowerCase(), copies = sessions.get(sessionId) ?? [];
      copies.push({ chat: result.chat, reader }); sessions.set(sessionId, copies);
      if (reader.state.referenceHistoryVerified && reader.physicalId) {
        trustedPhysicalIds.add(reader.physicalId);
        for (const id of reader.referencePhysicalIds) trustedPhysicalIds.add(id);
      }
    }
    if (!sessions.size) return unavailable(incomplete ? 'account_logs_incomplete' : 'no_token_events');
    // Legacy copies still share a canonical cumulative counter. Verified
    // reference lineages instead have disjoint physical suffixes, including
    // requests abandoned by a rollback. Deduplicate copies within each suffix.
    const partitions = [...sessions.values()].map(copies => {
      const groups = new Map<string, ReadCopy[]>();
      for (const copy of copies) {
        const id = copy.reader.physicalId;
        const key = id && trustedPhysicalIds.has(id) ? id : 'canonical-copy';
        const members = groups.get(key) ?? []; members.push(copy); groups.set(key, members);
      }
      const ambiguous = groups.size > 1 && groups.has('canonical-copy');
      incomplete ||= ambiguous;
      // A legacy or renamed cumulative copy cannot establish another physical
      // suffix. Fall back to the canonical subtotal and withhold a full price.
      return { groups: ambiguous ? [copies] : [...groups.values()], ambiguous };
    });
    const chats: ChatTokens[] = [];
    for (const { groups } of partitions) {
      const selected = groups.flatMap(copies => {
        const candidates = copies.flatMap(copy => copy.chat ? [copy.chat] : []);
        candidates.sort((a, b) => b.totalTokens - a.totalTokens || Number(b.complete) - Number(a.complete));
        return candidates.slice(0, 1);
      });
      const chat = selected.length ? aggregate(selected) : null;
      if (selected.length && !chat) return unavailable('counter_overflow');
      if (chat) chats.push(chat);
    }
    const account = chats.length ? aggregate(chats, incomplete) : null;
    const errorCode = chats.length && !account ? 'counter_overflow' : incomplete ? 'account_logs_incomplete' : !chats.length ? 'no_token_events' : null;
    if (periodErrorCode) return { account, errorCode, period: null, periodErrorCode };
    const periods: ChatTokens[] = [];
    let excludedReviewTokens = 0;
    let periodIncomplete = discoveryIncomplete || unreadableFileIncomplete, referenceUnavailable = false;
    for (const { groups, ambiguous } of partitions) {
      const sessionPeriods: ChatTokens[] = [];
      for (const copies of groups) {
        const candidates = copies.map(copy => ({ reader: copy.reader, snapshot: copy.reader.state.periodSnapshot(window!, now) }));
        if (candidates.some(candidate => !candidate.snapshot)) return { account, errorCode, period: null, periodErrorCode: 'counter_overflow' };
        candidates.sort((a, b) => b.snapshot!.totalTokens - a.snapshot!.totalTokens ||
          b.snapshot!.excludedReviewTokens - a.snapshot!.excludedReviewTokens || Number(b.snapshot!.complete) - Number(a.snapshot!.complete));
        const selected = candidates[0], snapshot = selected.snapshot!;
        periodIncomplete ||= ambiguous && candidates.some(candidate => candidate.snapshot!.totalTokens > 0);
        const reviewSubtotal = Math.max(...candidates.map(candidate => candidate.snapshot!.excludedReviewTokens));
        const reviewTotal = counter(excludedReviewTokens + reviewSubtotal);
        if (reviewTotal === null) return { account, errorCode, period: null, periodErrorCode: 'counter_overflow' };
        excludedReviewTokens = reviewTotal;
        const evidence = selected.reader.state.periodEvidence(window!, now);
        for (const candidate of candidates) {
          periodIncomplete ||= !candidate.snapshot!.complete;
          referenceUnavailable ||= !candidate.snapshot!.complete && candidate.reader.state.referenceHistoryUnavailable;
          if (candidate === selected || !candidate.snapshot!.totalTokens) continue;
          // Different copies of the same physical suffix must contain the
          // selected paid evidence. Distinct physical requests are never merged
          // merely because their counters and timestamps happen to match.
          for (const [key, occurrences] of candidate.reader.state.periodEvidence(window!, now)) {
            if ((evidence.get(key) ?? 0) < occurrences) { periodIncomplete = true; break; }
          }
        }
        if (snapshot.totalTokens > 0) sessionPeriods.push(snapshot);
      }
      if (sessionPeriods.length) {
        const session = aggregate(sessionPeriods);
        if (!session) return { account, errorCode, period: null, periodErrorCode: 'counter_overflow' };
        periods.push(session);
      }
    }
    const summed = aggregate(periods, periodIncomplete);
    return { account, errorCode, period: summed ? { ...summed, excludedReviewTokens, window: { ...window! } } : null,
      periodErrorCode: !summed ? 'counter_overflow' : periodIncomplete ? referenceUnavailable ? 'reference_history_unavailable' : 'period_logs_incomplete' : null };
  }
}
