import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, mkdir, rename, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountTokenReader, LocalTokenReader, TokenLogState, validThreadId } from '../src/local-tokens.ts';
import { estimateUsd, type TokenWindow } from '../src/tokens.ts';

const id = '11111111-2222-3333-4444-555555555555';
const meta = { type: 'session_meta', payload: { id, creator_account_id: 'account-a', base_instructions: { text: 'PRIVATE CONVERSATION' } } };
const context = (model = 'gpt-6.1-sol') => ({ type: 'turn_context', payload: { model, cwd: '/private-directory' } });
const count = (input: number, output: number, cached = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const event = (total: object, last = total) => ({ type: 'event_msg', timestamp: '2026-10-08T08:00:00Z', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const line = (row: object) => JSON.stringify(row) + '\n';
test('log deltas avoid repeats, follow model changes and detect gaps rather than estimating partial prices', () => {
  const state = new TokenLogState();
  [meta, context(), event(count(100, 20, 50)), event(count(100, 20, 50)), context('gpt-6-luna'), event(count(300100, 120, 50), count(300000, 100))].forEach(row => state.accept(line(row)));
  const chat = state.snapshot()!;
  assert.equal(chat.totalTokens, 300220); assert.equal(chat.segments.length, 2); assert.equal(chat.segments[1].longContext, true);
  assert.equal(chat.complete, true); assert.notEqual(estimateUsd(chat), null);
  assert.equal(JSON.stringify(chat).includes('PRIVATE'), false); assert.equal(JSON.stringify(chat).includes('account-a'), false);
  chat.segments[0].inputTokens = 0; assert.equal(state.snapshot()!.segments[0].inputTokens, 100);
  state.accept(line(event(count(300300, 150, 50), count(100, 10))));
  assert.equal(state.snapshot()!.complete, false); assert.equal(estimateUsd(state.snapshot()), null);
  assert.equal(validThreadId('../secrets'), false);
});
test('incremental reader waits for complete records, clears on truncation and enforces account/session ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-token-test-')); const path = join(root, `rollout-test-${id}.jsonl`);
  const reader = new LocalTokenReader(root);
  try {
    const first = line(meta) + line(context()) + line({ type: 'response_item', payload: { content: '私人內容' } }) + line(event(count(100, 20, 50)));
    await writeFile(path, first);
    assert.equal((await reader.read(id, 'account-a')).chat?.totalTokens, 120);
    assert.equal((await reader.read(id, 'account-b')).errorCode, 'log_identity_mismatch');
    const next = line(event(count(200, 40, 100), count(100, 20, 50)));
    await appendFile(path, next.slice(0, -2));
    assert.equal((await reader.read(id, 'account-a')).chat?.totalTokens, 120);
    await appendFile(path, next.slice(-2));
    assert.equal((await reader.read(id, 'account-a')).chat?.totalTokens, 240);
    await writeFile(path, line(meta) + line(context()) + line(event(count(10, 2))));
    assert.equal((await reader.read(id, 'account-a')).chat?.totalTokens, 12);
    await writeFile(path, line({ ...meta, payload: { ...meta.payload, id: 'different-session' } }));
    assert.equal((await reader.read(id, 'account-a')).chat, null);
    assert.equal((await reader.read(null, 'account-a')).errorCode, 'no_tracked_thread');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing cache-write or request split shows tokens but withholds price', () => {
  const state = new TokenLogState(); state.accept(line(meta)); state.accept(line(context()));
  const total = count(100, 20); delete (total as any).cache_write_input_tokens;
  state.accept(line(event(total)));
  assert.equal(state.snapshot()!.totalTokens, 120); assert.equal(estimateUsd(state.snapshot()), null);
  const changed = new TokenLogState(); changed.accept(line(meta)); changed.accept(line(context()));
  changed.accept(line(event(count(100, 20, 50)))); changed.accept(line(event(count(100, 20, 60))));
  assert.equal(changed.snapshot()!.cachedInputTokens, 60); assert.equal(estimateUsd(changed.snapshot()), null);
});

const secondId = '22222222-2222-3333-4444-555555555555';
const otherId = '33333333-2222-3333-4444-555555555555';
const session = (sessionId: string, accountId: string | null, input = 100, output = 20) =>
  line({ type: 'session_meta', payload: { id: sessionId, creator_account_id: accountId, base_instructions: { text: 'PRIVATE MESSAGE' } } }) +
  line(context()) + line({ type: 'response_item', payload: { content: 'PRIVATE MESSAGE' } }) + line(event(count(input, output)));
async function accountFixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-account-token-test-'));
  const active = join(root, 'sessions', '2026', '10', '11');
  const archived = join(root, 'archived_sessions');
  await mkdir(active, { recursive: true }); await mkdir(archived);
  return { root, active, archived, reader: new AccountTokenReader(root) };
}
test('account totals follow all owned chats, incremental appends, newly created chats and account changes', async () => {
  const f = await accountFixture();
  try {
    const first = join(f.active, `rollout-first-${id}.jsonl`);
    await writeFile(first, session(id, 'account-a'));
    await writeFile(join(f.active, `rollout-other-${otherId}.jsonl`), session(otherId, 'account-b', 500, 100));
    await writeFile(join(f.active, 'rollout-unknown.jsonl'), session('44444444-2222-3333-4444-555555555555', null, 1000, 20));
    let result = await f.reader.read('account-a');
    assert.equal(result.account?.totalTokens, 120); assert.equal(result.account?.sessionCount, 1);
    const next = line(event(count(200, 40), count(100, 20)));
    await appendFile(first, next.slice(0, -2));
    assert.equal((await f.reader.read('account-a')).account?.totalTokens, 120);
    await appendFile(first, next.slice(-2));
    await writeFile(join(f.active, `rollout-new-${secondId}.jsonl`), session(secondId, 'account-a', 50, 10));
    result = await f.reader.read('account-a');
    assert.equal(result.account?.totalTokens, 300); assert.equal(result.account?.sessionCount, 2);
    assert.equal(result.account?.segments.length, 1); assert.notEqual(estimateUsd(result.account), null);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(JSON.stringify(result).includes('account-a'), false);
    assert.equal(JSON.stringify(result).includes(id), false);
    assert.equal((await f.reader.read('account-b')).account?.totalTokens, 600);
    assert.equal((await f.reader.read('account-a')).account?.totalTokens, 300);
    assert.equal((await f.reader.read('missing-account')).account, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('account totals handle duplicate IDs, truncation, archive moves and deleted logs', async () => {
  const f = await accountFixture();
  try {
    const original = join(f.active, `rollout-original-${id}.jsonl`);
    const copy = join(f.archived, `rollout-copy-${id}.jsonl`);
    await writeFile(original, session(id, 'account-a'));
    await writeFile(copy, session(id, 'account-a', 200, 40));
    assert.equal((await f.reader.read('account-a')).account?.totalTokens, 240);
    assert.equal((await f.reader.read('account-a')).account?.sessionCount, 1);
    await rm(copy); await writeFile(original, session(id, 'account-a', 10, 2));
    assert.equal((await f.reader.read('account-a')).account?.totalTokens, 12);
    await rename(original, copy);
    assert.equal((await f.reader.read('account-a')).account?.totalTokens, 12);
    await rm(copy);
    assert.equal((await f.reader.read('account-a')).account, null);
    await writeFile(original, session(secondId, 'account-a', 30, 3));
    assert.equal((await f.reader.read('account-a')).account?.totalTokens, 33);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('fork boundaries exclude inherited counters and preserve canonical child ownership', async () => {
  const f = await accountFixture();
  try {
    await writeFile(join(f.active, `rollout-parent-${id}.jsonl`), session(id, 'account-a'));
    const child = line({ type: 'session_meta', payload: { id: secondId, creator_account_id: 'account-a', forked_from_id: id, subagent_history_start_ordinal: 4 } }) +
      line(meta) + line(context()) + line(event(count(100, 20))) +
      line(context('gpt-6-luna')) + line(event(count(150, 30), count(50, 10)));
    await writeFile(join(f.active, `rollout-child-${secondId}.jsonl`), child);
    const result = await f.reader.read('account-a');
    assert.equal(result.account?.totalTokens, 180); assert.equal(result.account?.sessionCount, 2);
    assert.equal(result.account?.complete, true); assert.equal(result.account?.segments.length, 2);
    assert.notEqual(estimateUsd(result.account), null);
    await writeFile(join(f.archived, `rollout-ambiguous-${otherId}.jsonl`), line({ type: 'session_meta', payload: { id: otherId, creator_account_id: 'account-a', forked_from_id: id } }) + line(context()) + line(event(count(500, 100))));
    const incomplete = await f.reader.read('account-a');
    assert.equal(incomplete.account?.totalTokens, 180); assert.equal(incomplete.account?.complete, false);
    assert.equal(incomplete.errorCode, 'account_logs_incomplete'); assert.equal(estimateUsd(incomplete.account), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('account readers reject symlinked files/directories and unsafe aggregate overflow', async () => {
  const f = await accountFixture();
  const outside = await mkdtemp(join(tmpdir(), 'codex-account-outside-'));
  try {
    const file = join(outside, `rollout-private-${id}.jsonl`);
    await writeFile(file, session(id, 'account-a'));
    await symlink(file, join(f.active, `rollout-linked-${id}.jsonl`));
    await symlink(outside, join(f.active, 'linked-directory'));
    assert.equal((await f.reader.read('account-a')).account, null);
    await writeFile(join(f.active, `rollout-big-${secondId}.jsonl`), session(secondId, 'account-a', Number.MAX_SAFE_INTEGER - 10, 0));
    await writeFile(join(f.active, `rollout-small-${otherId}.jsonl`), session(otherId, 'account-a', 50, 10));
    const result = await f.reader.read('account-a');
    assert.equal(result.account, null); assert.equal(result.errorCode, 'counter_overflow');
  } finally { await rm(f.root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('fork request counter resets can exceed inherited totals and ambiguous first deltas are excluded', async () => {
  const f = await accountFixture();
  try {
    await writeFile(join(f.active, `rollout-parent-${id}.jsonl`), session(id, 'account-a'));
    const prefix = line({ type: 'session_meta', payload: { id: secondId, creator_account_id: 'account-a', forked_from_id: id, subagent_history_start_ordinal: 4 } }) +
      line(meta) + line(context()) + line(event(count(100, 20))) + line(context());
    const child = join(f.active, `rollout-child-${secondId}.jsonl`);
    await writeFile(child, prefix + line(event(count(500, 100), count(500, 100))));
    const reset = await f.reader.read('account-a');
    assert.equal(reset.account?.totalTokens, 720); assert.equal(reset.account?.complete, true);
    assert.notEqual(estimateUsd(reset.account), null);
    await writeFile(child, prefix + line(event(count(300, 60), count(50, 10))));
    const ambiguous = await f.reader.read('account-a');
    assert.equal(ambiguous.account?.totalTokens, 120); assert.equal(ambiguous.account?.complete, false);
    assert.equal(ambiguous.errorCode, 'account_logs_incomplete'); assert.equal(estimateUsd(ambiguous.account), null);
    await writeFile(child, prefix + line(event(count(100, 20), count(100, 20))) + line(event(count(150, 30), count(50, 10))));
    const equality = await f.reader.read('account-a');
    assert.equal(equality.account?.totalTokens, 120); assert.equal(equality.account?.complete, false);
    assert.equal(equality.errorCode, 'account_logs_incomplete'); assert.equal(estimateUsd(equality.account), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('an unreadable subtree withholds a partial account price', { skip: process.getuid?.() === 0 }, async () => {
  const f = await accountFixture();
  const blocked = join(f.active, 'unreadable');
  try {
    await writeFile(join(f.active, `rollout-readable-${id}.jsonl`), session(id, 'account-a'));
    await mkdir(blocked);
    await writeFile(join(blocked, `rollout-blocked-${secondId}.jsonl`), session(secondId, 'account-a'));
    await chmod(blocked, 0o000);
    const result = await f.reader.read('account-a');
    assert.equal(result.account?.totalTokens, 120); assert.equal(result.account?.complete, false);
    assert.equal(result.errorCode, 'account_logs_incomplete'); assert.equal(estimateUsd(result.account), null);
  } finally { await chmod(blocked, 0o700).catch(() => {}); await rm(f.root, { recursive: true, force: true }); }
});
test('invalid owned counters withhold price and rewritten ownership is revalidated', async () => {
  const f = await accountFixture();
  try {
    const first = join(f.active, `rollout-first-${id}.jsonl`);
    const invalid = join(f.active, `rollout-invalid-${secondId}.jsonl`);
    await writeFile(first, session(id, 'account-a'));
    await writeFile(invalid, line({ type: 'session_meta', payload: { id: secondId, creator_account_id: 'account-a' } }) + line(context()) + line(event(count(10, 2, 100))));
    const partial = await f.reader.read('account-a');
    assert.equal(partial.account?.totalTokens, 120); assert.equal(partial.account?.complete, false);
    assert.equal(partial.errorCode, 'account_logs_incomplete'); assert.equal(estimateUsd(partial.account), null);
    await rm(invalid);
    await writeFile(first, session(id, 'account-b') + line({ type: 'response_item', payload: { content: 'longer replacement record'.repeat(100) } }));
    assert.equal((await f.reader.read('account-a')).account, null);
    assert.equal((await f.reader.read('account-b')).account?.totalTokens, 120);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const windowStart = Date.parse('2026-10-12T00:00:00Z');
const currentWindow: TokenWindow = { startAtMs: windowStart, endAtMs: windowStart + 5 * 60 * 60_000, windowMinutes: 300 };
const observedNow = windowStart + 4 * 60 * 60_000;
const timedEvent = (atMs: number, total: object, last = total) => ({ ...event(total, last), timestamp: new Date(atMs).toISOString() });
const ownedMeta = (sessionId = id, accountId = 'account-a') => line({ type: 'session_meta', payload: { id: sessionId, creator_account_id: accountId } });

test('current quota period includes start/observed-time boundaries, excludes old/end/future usage, and preserves model pricing', async () => {
  const f = await accountFixture();
  try {
    const log = ownedMeta() + line(context()) + line(timedEvent(windowStart - 60_000, count(100, 20))) +
      line(timedEvent(windowStart, count(200, 40), count(100, 20))) + line(context('gpt-6-luna')) +
      line(timedEvent(observedNow, count(250, 50), count(50, 10))) +
      line(timedEvent(observedNow + 60_000, count(300, 60), count(50, 10))) +
      line(timedEvent(currentWindow.endAtMs, count(350, 70), count(50, 10)));
    await writeFile(join(f.active, `rollout-boundary-${id}.jsonl`), log);
    await writeFile(join(f.archived, `rollout-copy-${id}.jsonl`), log);
    await writeFile(join(f.active, `rollout-other-${otherId}.jsonl`), ownedMeta(otherId, 'account-b') + line(context()) + line(timedEvent(windowStart, count(1000, 200))));
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.account?.totalTokens, 420);
    assert.equal(result.period?.totalTokens, 180); assert.equal(result.period?.sessionCount, 1);
    assert.equal(result.period?.segments.length, 2); assert.equal(result.period?.complete, true);
    assert.equal(result.period?.updatedAtMs, observedNow); assert.equal(result.periodErrorCode, null);
    assert.deepEqual(result.period?.window, currentWindow); assert.notEqual(estimateUsd(result.period), null);
    assert.equal(JSON.stringify(result.period).includes(id), false); assert.equal(JSON.stringify(result.period).includes('account-a'), false);
    const other = await f.reader.read('account-b', currentWindow, observedNow);
    assert.equal(other.period?.totalTokens, 1200);
    assert.equal((await f.reader.read('account-a', currentWindow, observedNow)).period?.totalTokens, 180);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('period totals increment without rereading old consumption, expire at reset, and recompute a new or earlier window', async () => {
  const f = await accountFixture();
  try {
    const path = join(f.active, `rollout-incremental-${id}.jsonl`);
    await writeFile(path, ownedMeta() + line(context()) + line(timedEvent(windowStart - 1, count(100, 20))));
    let result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.period?.totalTokens, 0); assert.equal(result.period?.complete, true);
    assert.equal(result.period?.sessionCount, 0); assert.equal(estimateUsd(result.period), 0);
    const next = line(timedEvent(windowStart + 60_000, count(150, 30), count(50, 10)));
    await appendFile(path, next.slice(0, -2));
    assert.equal((await f.reader.read('account-a', currentWindow, observedNow)).period?.totalTokens, 0);
    await appendFile(path, next.slice(-2));
    assert.equal((await f.reader.read('account-a', currentWindow, observedNow)).period?.totalTokens, 60);
    const expired = await f.reader.read('account-a', currentWindow, currentWindow.endAtMs);
    assert.equal(expired.period, null); assert.equal(expired.periodErrorCode, 'window_expired');
    const following = { ...currentWindow, startAtMs: currentWindow.endAtMs, endAtMs: currentWindow.endAtMs + 5 * 60 * 60_000 };
    result = await f.reader.read('account-a', following, following.startAtMs + 1);
    assert.equal(result.period?.totalTokens, 0); assert.equal(result.period?.complete, true);
    assert.equal((await f.reader.read('account-a', currentWindow, observedNow)).period?.totalTokens, 60);
    assert.equal((await f.reader.read('account-a', null, observedNow)).periodErrorCode, 'window_unavailable');
    assert.equal((await f.reader.read('account-a', { ...currentWindow, endAtMs: windowStart }, observedNow)).periodErrorCode, 'window_unavailable');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('old missing price fields do not taint precise current deltas; current gaps and unknown timestamps withhold USD', async () => {
  const f = await accountFixture();
  try {
    const path = join(f.active, `rollout-scope-${id}.jsonl`);
    const old = count(100, 20); delete (old as any).cache_write_input_tokens;
    const prefix = ownedMeta() + line(context()) + line(timedEvent(windowStart - 60_000, old));
    await writeFile(path, prefix + line(timedEvent(windowStart + 60_000, count(150, 30), count(50, 10))));
    const valid = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(valid.account?.complete, false); assert.equal(valid.period?.totalTokens, 60);
    assert.equal(valid.period?.complete, true); assert.notEqual(estimateUsd(valid.period), null);
    await appendFile(path, line(timedEvent(windowStart + 120_000, count(300, 60), count(50, 10))));
    const gap = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(gap.period?.totalTokens, 60); assert.equal(gap.period?.complete, false);
    assert.equal(gap.periodErrorCode, 'period_logs_incomplete'); assert.equal(estimateUsd(gap.period), null);
    const unknown = event(count(200, 40), count(50, 10)); delete (unknown as any).timestamp;
    await writeFile(path, prefix + line(timedEvent(windowStart + 60_000, count(150, 30), count(50, 10))) + line(unknown));
    const missing = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(missing.period?.totalTokens, 60); assert.equal(missing.period?.complete, false);
    assert.equal(estimateUsd(missing.period), null);
    await writeFile(path, ownedMeta() + line(context()) + line({ ...timedEvent(windowStart - 120_000, count(10, 2)), payload: { type: 'token_count', info: { total_token_usage: { broken: true } } } }) +
      line(timedEvent(windowStart - 60_000, count(100, 20))) + line(timedEvent(windowStart + 60_000, count(150, 30), count(50, 10))));
    const oldMalformed = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(oldMalformed.period?.totalTokens, 60); assert.equal(oldMalformed.period?.complete, true);
    assert.notEqual(estimateUsd(oldMalformed.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('window aggregation deduplicates a current fork and excludes inherited or ambiguous counters', async () => {
  const f = await accountFixture();
  try {
    await writeFile(join(f.active, `rollout-parent-${id}.jsonl`), ownedMeta() + line(context()) + line(timedEvent(windowStart - 60_000, count(100, 20))));
    const child = line({ type: 'session_meta', payload: { id: secondId, creator_account_id: 'account-a', forked_from_id: id, subagent_history_start_ordinal: 4 } }) +
      line(meta) + line(context()) + line(timedEvent(windowStart - 60_000, count(100, 20))) +
      line(context()) + line(timedEvent(windowStart + 60_000, count(150, 30), count(50, 10)));
    await writeFile(join(f.active, `rollout-child-${secondId}.jsonl`), child);
    await writeFile(join(f.archived, `rollout-copy-${secondId}.jsonl`), child);
    const good = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(good.period?.totalTokens, 60); assert.equal(good.period?.sessionCount, 1); assert.equal(good.period?.complete, true);
    await writeFile(join(f.active, `rollout-ambiguous-${otherId}.jsonl`), line({ type: 'session_meta', payload: { id: otherId, creator_account_id: 'account-a', forked_from_id: id } }) + line(context()) + line(timedEvent(windowStart + 120_000, count(500, 100))));
    const ambiguous = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(ambiguous.period?.totalTokens, 60); assert.equal(ambiguous.period?.complete, false); assert.equal(estimateUsd(ambiguous.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('an unreadable rollout withholds price for a partial current window', { skip: process.getuid?.() === 0 }, async () => {
  const f = await accountFixture();
  const blocked = join(f.active, `rollout-unreadable-${secondId}.jsonl`);
  try {
    await writeFile(join(f.active, `rollout-readable-${id}.jsonl`), ownedMeta() + line(context()) + line(timedEvent(windowStart + 60_000, count(100, 20))));
    await writeFile(blocked, ownedMeta(secondId) + line(context()) + line(timedEvent(windowStart + 60_000, count(50, 10))));
    await chmod(blocked, 0o000);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.period?.totalTokens, 120); assert.equal(result.period?.complete, false);
    assert.equal(result.periodErrorCode, 'period_logs_incomplete'); assert.equal(estimateUsd(result.period), null);
  } finally { await chmod(blocked, 0o600).catch(() => {}); await rm(f.root, { recursive: true, force: true }); }
});

test('period duplicate selection uses current request evidence rather than larger archived lifetime counters', async () => {
  const f = await accountFixture();
  try {
    const active = join(f.active, `rollout-current-${id}.jsonl`);
    const archived = join(f.archived, `rollout-old-${id}.jsonl`);
    await writeFile(archived, ownedMeta() + line(context()) + line(timedEvent(windowStart - 60_000, count(100, 20))));
    const current = ownedMeta() + line(context()) + line(timedEvent(windowStart + 60_000, count(50, 10)));
    await writeFile(active, current);
    const selected = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(selected.account?.totalTokens, 120); assert.equal(selected.period?.totalTokens, 60);
    assert.equal(selected.period?.complete, true); assert.notEqual(estimateUsd(selected.period), null);
    await writeFile(archived, current + line(timedEvent(windowStart + 120_000, count(100, 20), count(50, 10))));
    const subset = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(subset.period?.totalTokens, 120); assert.equal(subset.period?.sessionCount, 1);
    assert.equal(subset.period?.complete, true); assert.notEqual(estimateUsd(subset.period), null);
    await writeFile(active, ownedMeta() + line(context()) + line(timedEvent(windowStart + 180_000, count(70, 14))));
    const conflicting = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(conflicting.period?.totalTokens, 120); assert.equal(conflicting.period?.complete, false);
    assert.equal(conflicting.periodErrorCode, 'period_logs_incomplete'); assert.equal(estimateUsd(conflicting.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('free safety reviews are excluded from counted period tokens without breaking paid deltas around them', async () => {
  const f = await accountFixture();
  try {
    const log = ownedMeta() + line(context('codex-auto-review')) + line(timedEvent(windowStart, count(100, 20))) +
      line(context()) + line(timedEvent(windowStart + 60_000, count(200, 40), count(100, 20))) +
      line(context('codex-auto-review')) + line(timedEvent(windowStart + 120_000, count(250, 50), count(50, 10))) +
      line(context()) + line(timedEvent(windowStart + 180_000, count(300, 60), count(50, 10)));
    await writeFile(join(f.active, `rollout-mixed-${id}.jsonl`), log);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.account?.totalTokens, 360); // Legacy cumulative accounting is unchanged.
    assert.equal(result.period?.totalTokens, 180); assert.equal(result.period?.inputTokens, 150);
    assert.equal(result.period?.outputTokens, 30); assert.equal(result.period?.excludedReviewTokens, 180);
    assert.equal(result.period?.sessionCount, 1); assert.equal(result.period?.complete, true);
    assert.deepEqual(result.period?.segments.map(segment => segment.model), ['gpt-6.1-sol']);
    assert.equal(estimateUsd(result.period), 0.0006);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('review-only periods are zero-cost and duplicate copies preserve one complete excluded subtotal', async () => {
  const f = await accountFixture();
  try {
    const first = count(100, 20), next = count(150, 30), last = count(50, 10);
    for (const value of [first, next, last]) delete (value as any).cache_write_input_tokens;
    const prefix = ownedMeta() + line(context('codex-auto-review')) + line(timedEvent(windowStart + 60_000, first));
    const full = prefix + line(timedEvent(windowStart + 120_000, next, last));
    await writeFile(join(f.active, `rollout-review-${id}.jsonl`), full);
    await writeFile(join(f.archived, `rollout-review-prefix-${id}.jsonl`), prefix);
    let result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.period?.totalTokens, 0); assert.equal(result.period?.segments.length, 0);
    assert.equal(result.period?.sessionCount, 0); assert.equal(result.period?.excludedReviewTokens, 180);
    assert.equal(result.period?.complete, true); assert.equal(estimateUsd(result.period), 0);
    assert.equal(result.account?.complete, false); // Free price-field omissions do not taint paid scope.
    await writeFile(join(f.archived, `rollout-review-prefix-${id}.jsonl`), full);
    result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.period?.excludedReviewTokens, 180); assert.equal(estimateUsd(result.period), 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('excluded reviews obey period/time boundaries without assigning undated free events to paid scope', async () => {
  const f = await accountFixture();
  try {
    const path = join(f.active, `rollout-review-time-${id}.jsonl`);
    const prefix = ownedMeta() + line(context('codex-auto-review')) + line(timedEvent(windowStart - 1, count(100, 20))) +
      line(timedEvent(windowStart, count(200, 40), count(100, 20))) +
      line(timedEvent(observedNow, count(250, 50), count(50, 10))) +
      line(timedEvent(observedNow + 60_000, count(300, 60), count(50, 10))) +
      line(timedEvent(currentWindow.endAtMs, count(350, 70), count(50, 10)));
    await writeFile(path, prefix);
    const bounded = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(bounded.period?.totalTokens, 0); assert.equal(bounded.period?.excludedReviewTokens, 180);
    assert.equal(bounded.period?.complete, true); assert.equal(estimateUsd(bounded.period), 0);
    const unknown = timedEvent(windowStart + 180_000, count(400, 80), count(50, 10)); delete (unknown as any).timestamp;
    await appendFile(path, line(unknown));
    const partial = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(partial.period?.totalTokens, 0); assert.equal(partial.period?.excludedReviewTokens, 180);
    // Undated reviews are free regardless of when they occurred, but their
    // excluded subtotal cannot safely be assigned to this interval.
    assert.equal(partial.period?.complete, true); assert.equal(estimateUsd(partial.period), 0);
    await writeFile(path, prefix.replace('codex-auto-review', 'gpt-6.1-sol') + line(unknown));
    const undatedPaid = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(undatedPaid.period?.complete, false); assert.equal(estimateUsd(undatedPaid.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('known free copy differences do not invalidate identical paid evidence; other unknown models remain unpriced', async () => {
  const f = await accountFixture();
  try {
    const active = join(f.active, `rollout-paid-review-${id}.jsonl`);
    const archived = join(f.archived, `rollout-paid-review-copy-${id}.jsonl`);
    const paid = ownedMeta() + line(context()) + line(timedEvent(windowStart + 60_000, count(50, 10)));
    await writeFile(active, paid + line(context('codex-auto-review')) + line(timedEvent(windowStart + 120_000, count(100, 20), count(50, 10))));
    await writeFile(archived, paid + line(context('codex-auto-review')) + line(timedEvent(windowStart + 180_000, count(120, 24), count(70, 14))));
    const copies = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(copies.period?.totalTokens, 60); assert.equal(copies.period?.excludedReviewTokens, 84);
    assert.equal(copies.period?.complete, true); assert.notEqual(estimateUsd(copies.period), null);
    await rm(archived);
    await writeFile(active, ownedMeta() + line(context('codex-auto-review-other')) + line(timedEvent(windowStart + 60_000, count(50, 10))));
    const unknown = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(unknown.period?.totalTokens, 60); assert.equal(unknown.period?.excludedReviewTokens, 0);
    assert.equal(estimateUsd(unknown.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('unresolved cumulative gaps across paid/review events do not create a free classification shortcut', async () => {
  const f = await accountFixture();
  try {
    await writeFile(join(f.active, `rollout-paid-review-gap-${id}.jsonl`), ownedMeta() + line(context()) +
      line(timedEvent(windowStart + 60_000, count(50, 10))) + line(context('codex-auto-review')) +
      line(timedEvent(windowStart + 120_000, count(300, 60), count(100, 20))));
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.period?.totalTokens, 60); assert.equal(result.period?.excludedReviewTokens, 0);
    assert.equal(result.period?.complete, false); assert.equal(estimateUsd(result.period), null);
    assert.equal(result.periodErrorCode, 'period_logs_incomplete');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('an undated exact free review advances the raw baseline without blocking paid requests before and after it', async () => {
  const f = await accountFixture();
  try {
    const review = event(count(150, 30), count(50, 10)); delete (review as any).timestamp;
    const log = ownedMeta() + line(context()) + line(timedEvent(windowStart + 60_000, count(100, 20))) +
      line(context('codex-auto-review')) + line(review) + line(context()) +
      line(timedEvent(windowStart + 120_000, count(200, 40), count(50, 10)));
    await writeFile(join(f.active, `rollout-undated-review-${id}.jsonl`), log);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.account?.totalTokens, 240); assert.equal(result.period?.totalTokens, 180);
    assert.equal(result.period?.excludedReviewTokens, 0); assert.equal(result.period?.complete, true);
    assert.notEqual(estimateUsd(result.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const largeDummyText = 'DUMMY CONTENT '.repeat(310_000);
test('an undated free review is not assigned to an interval starting at the Unix epoch', () => {
  const state = new TokenLogState(0);
  const review = event(count(50, 10)); delete (review as any).timestamp;
  [meta, context('codex-auto-review'), review].forEach(row => state.accept(line(row)));
  const period = state.periodSnapshot({ startAtMs: 0, endAtMs: 300 * 60_000, windowMinutes: 300 }, 60_000);
  assert.equal(period?.excludedReviewTokens, 0); assert.equal(period?.totalTokens, 0);
  assert.equal(period?.complete, true); assert.equal(estimateUsd(period), 0);
});

test('oversized ordinary records preserve paid pricing across chunks and ignore nested or escaped fake discriminators', async () => {
  const f = await accountFixture();
  try {
    const paid = ownedMeta() + line(context()) + line(timedEvent(windowStart + 60_000, count(100, 20)));
    const paddingRow = line({ type: 'response_item', payload: { content: 'padding' } });
    const padding = (65_536 - 20 - (Buffer.byteLength(paid) + Buffer.byteLength(paddingRow)) % 65_536 + 65_536) % 65_536;
    const aligned = paid + paddingRow.slice(0, -1) + ' '.repeat(padding) + '\n';
    const ordinary = line({ type: 'response_item', payload: { type: 'turn_context', model: 'fake-model', nested: { type: 'token_count' }, text: largeDummyText } });
    const escaped = ordinary.replace('"type":"response_item"', '"\\u0074ype":"response_item"');
    const userMessage = line({ type: 'event_msg', payload: { type: 'user_message', message: largeDummyText, nested: { type: 'token_count' } } });
    const itemCompleted = line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'function_call_output', output: largeDummyText, nested: { type: 'token_count' } } } });
    await writeFile(join(f.active, `rollout-ordinary-large-${id}.jsonl`), aligned + ordinary + escaped + userMessage + itemCompleted + line(timedEvent(windowStart + 120_000, count(150, 30), count(50, 10))));
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.period?.totalTokens, 180); assert.equal(result.period?.complete, true);
    assert.notEqual(estimateUsd(result.period), null); assert.equal(JSON.stringify(result).includes('DUMMY'), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('oversized relevant, malformed, late-discriminator and duplicate-discriminator records remain conservative', async () => {
  const f = await accountFixture();
  try {
    const path = join(f.active, `rollout-relevant-large-${id}.jsonl`);
    const paid = ownedMeta() + line(context()) + line(timedEvent(windowStart + 60_000, count(100, 20)));
    const following = line(timedEvent(windowStart + 120_000, count(150, 30), count(50, 10)));
    const ordinaryPayload = JSON.stringify({ content: largeDummyText });
    const variants = [
      line({ type: 'turn_context', payload: { model: 'gpt-6-luna', type: 'response_item', text: largeDummyText } }),
      `{"type":"response_item","payload":${ordinaryPayload},"type":"turn_context"}\n`,
      line({ payload: { content: largeDummyText }, type: 'response_item' }),
      `{"type":"response_item","payload":{"content":"${largeDummyText}\n`,
      line({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: count(100, 20), last_token_usage: count(100, 20) }, text: largeDummyText } }),
    ];
    for (const oversized of variants) {
      await writeFile(path, paid + oversized + following);
      const result = await f.reader.read('account-a', currentWindow, observedNow);
      assert.equal(result.period?.complete, false); assert.equal(estimateUsd(result.period), null);
      assert.equal(result.periodErrorCode, 'period_logs_incomplete');
    }
    await writeFile(path, paid + variants[0] + following);
    const missedModel = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(missedModel.period?.segments.some(segment => segment.model === null), true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('skipping an oversized ordinary inherited record preserves the child fork ordinal boundary', async () => {
  const f = await accountFixture();
  try {
    const log = line({ type: 'session_meta', payload: { id: secondId, creator_account_id: 'account-a', forked_from_id: id, subagent_history_start_ordinal: 6 } }) +
      line(meta) + line(context()) + line(timedEvent(windowStart - 60_000, count(100, 20))) +
      line({ type: 'response_item', payload: { content: largeDummyText } }) + line(context()) +
      line(timedEvent(windowStart + 60_000, count(150, 30), count(50, 10)));
    await writeFile(join(f.active, `rollout-fork-large-${secondId}.jsonl`), log);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.period?.totalTokens, 60); assert.equal(result.period?.complete, true);
    assert.notEqual(estimateUsd(result.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
