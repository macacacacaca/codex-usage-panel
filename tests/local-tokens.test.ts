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

const threadSettings = (threadId: unknown, model?: string) => ({
  type: 'event_msg', timestamp: new Date(windowStart + 120_000).toISOString(),
  payload: { type: 'thread_settings_applied', thread_id: threadId, thread_settings: model === undefined ? {} : { model } },
});
const legacyForkPrefix = () =>
  line({ type: 'session_meta', payload: { id: secondId, creator_account_id: 'account-a', forked_from_id: id } }) +
  line({ ...meta, payload: { ...meta.payload, creator_account_id: 'account-b' } }) + line(context('gpt-6-astra')) +
  line(timedEvent(windowStart + 30_000, count(1000, 200, 100))) + line(threadSettings(id, 'gpt-6-astra')) +
  line(timedEvent(windowStart + 60_000, count(1100, 220, 100), count(100, 20)));
const firstLegacyChildRequest = () => line(timedEvent(windowStart + 180_000, count(1150, 230, 120), count(50, 10, 20)));

test('legacy fork ownership markers exclude current-window copied parent tokens and price only the child request', async () => {
  const f = await accountFixture();
  try {
    const log = legacyForkPrefix() + line(threadSettings(secondId.toUpperCase(), 'gpt-6-luna')) + firstLegacyChildRequest();
    await writeFile(join(f.active, `rollout-legacy-${secondId}.jsonl`), log);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.errorCode, null); assert.equal(result.periodErrorCode, null);
    for (const snapshot of [result.account, result.period]) {
      assert.equal(snapshot?.totalTokens, 60); assert.equal(snapshot?.inputTokens, 50);
      assert.equal(snapshot?.outputTokens, 10); assert.equal(snapshot?.cachedInputTokens, 20);
      assert.equal(snapshot?.sessionCount, 1); assert.equal(snapshot?.complete, true);
      assert.deepEqual(snapshot?.segments.map(segment => segment.model), ['gpt-6-luna']);
      assert.ok(Math.abs(estimateUsd(snapshot)! - 0.0000082) < 1e-15);
    }
    assert.equal((await f.reader.read('account-b', currentWindow, observedNow)).account, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('legacy forks without a valid canonical ownership marker remain ambiguous', async () => {
  const f = await accountFixture();
  try {
    const path = join(f.active, `rollout-legacy-unowned-${secondId}.jsonl`);
    const markers = ['', line(threadSettings(otherId, 'gpt-6-luna')), line(threadSettings(null, 'gpt-6-luna')),
      line(threadSettings(`${secondId}/invalid`, 'gpt-6-luna')),
      line({ ...threadSettings(secondId, 'gpt-6-luna'), type: 'response_item' })];
    for (const marker of markers) {
      await writeFile(path, legacyForkPrefix() + marker + line(context('gpt-6-luna')) + firstLegacyChildRequest());
      const result = await f.reader.read('account-a', currentWindow, observedNow);
      assert.equal(result.account, null); assert.equal(result.errorCode, 'account_logs_incomplete');
      assert.equal(result.period?.totalTokens, 0); assert.equal(result.period?.complete, false);
      assert.equal(result.periodErrorCode, 'period_logs_incomplete'); assert.equal(estimateUsd(result.period), null);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('appended canonical markers resolve a legacy fork incrementally while retaining its inherited counter baseline', async () => {
  const f = await accountFixture();
  try {
    const path = join(f.active, `rollout-legacy-incremental-${secondId}.jsonl`);
    await writeFile(path, legacyForkPrefix());
    const ambiguous = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(ambiguous.account, null); assert.equal(ambiguous.period?.totalTokens, 0);
    assert.equal(ambiguous.period?.complete, false); assert.equal(estimateUsd(ambiguous.period), null);
    const marker = line(threadSettings(secondId, 'gpt-6-luna'));
    await appendFile(path, marker.slice(0, -2));
    assert.equal((await f.reader.read('account-a', currentWindow, observedNow)).period?.complete, false);
    await appendFile(path, marker.slice(-2) + firstLegacyChildRequest());
    const recovered = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(recovered.account?.totalTokens, 60); assert.equal(recovered.account?.complete, true);
    assert.equal(recovered.period?.totalTokens, 60); assert.equal(recovered.period?.complete, true);
    assert.equal(recovered.errorCode, null); assert.equal(recovered.periodErrorCode, null);
    assert.ok(Math.abs(estimateUsd(recovered.period)! - 0.0000082) < 1e-15);
    await appendFile(path, line(timedEvent(windowStart + 240_000, count(1200, 240, 140), count(50, 10, 20))));
    const next = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(next.account?.totalTokens, 120); assert.equal(next.period?.totalTokens, 120);
    assert.equal(next.period?.complete, true); assert.ok(Math.abs(estimateUsd(next.period)! - 0.0000164) < 1e-15);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('later same-owner markers cannot clear a real child request gap after a legacy fork boundary', async () => {
  const f = await accountFixture();
  try {
    const path = join(f.active, `rollout-legacy-gap-${secondId}.jsonl`);
    await writeFile(path, legacyForkPrefix() + line(threadSettings(secondId, 'gpt-6-luna')) + firstLegacyChildRequest() +
      line(timedEvent(windowStart + 240_000, count(1300, 260, 120), count(50, 10))));
    const gap = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(gap.account?.complete, false); assert.equal(gap.period?.totalTokens, 60);
    assert.equal(gap.period?.complete, false); assert.equal(estimateUsd(gap.period), null);
    await appendFile(path, line(threadSettings(secondId, 'gpt-6-luna')) +
      line(timedEvent(windowStart + 300_000, count(1350, 270, 120), count(50, 10))));
    const later = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(later.account?.totalTokens, 300); assert.equal(later.account?.complete, false);
    assert.equal(later.period?.totalTokens, 120); assert.equal(later.period?.complete, false);
    assert.equal(later.periodErrorCode, 'period_logs_incomplete'); assert.equal(estimateUsd(later.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ownership markers cannot revive a fork with an explicitly bounded ambiguous first request', async () => {
  const f = await accountFixture();
  try {
    const log = line({ type: 'session_meta', payload: { id: secondId, creator_account_id: 'account-a', forked_from_id: id, subagent_history_start_ordinal: 4 } }) +
      line(meta) + line(context()) + line(timedEvent(windowStart, count(100, 20))) + line(context()) +
      line(timedEvent(windowStart + 60_000, count(300, 60), count(50, 10))) +
      line(threadSettings(secondId, 'gpt-6-luna')) + line(timedEvent(windowStart + 180_000, count(350, 70), count(50, 10)));
    await writeFile(join(f.active, `rollout-bounded-ambiguous-${secondId}.jsonl`), log);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.account, null); assert.equal(result.errorCode, 'account_logs_incomplete');
    assert.equal(result.period?.totalTokens, 0); assert.equal(result.period?.complete, false);
    assert.equal(result.periodErrorCode, 'period_logs_incomplete'); assert.equal(estimateUsd(result.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('legacy ownership markers clear copied model attribution and accept a later own turn context', async () => {
  const f = await accountFixture();
  try {
    const path = join(f.active, `rollout-legacy-model-${secondId}.jsonl`);
    for (const model of [undefined, '']) {
      await writeFile(path, legacyForkPrefix() + line(threadSettings(secondId, model)) + firstLegacyChildRequest());
      const unknown = await f.reader.read('account-a', currentWindow, observedNow);
      assert.equal(unknown.period?.totalTokens, 60); assert.equal(unknown.period?.complete, false);
      assert.deepEqual(unknown.period?.segments.map(segment => segment.model), [null]);
      assert.equal(estimateUsd(unknown.period), null);
    }
    await writeFile(path, legacyForkPrefix() + line(threadSettings(secondId)) + line(context('gpt-6-luna')) + firstLegacyChildRequest());
    const ownModel = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(ownModel.period?.totalTokens, 60); assert.equal(ownModel.period?.complete, true);
    assert.deepEqual(ownModel.period?.segments.map(segment => segment.model), ['gpt-6-luna']);
    assert.ok(Math.abs(estimateUsd(ownModel.period)! - 0.0000082) < 1e-15);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a malformed legacy ownership marker cannot be replaced by a later resume marker after own usage', () => {
  const state = new TokenLogState(windowStart);
  legacyForkPrefix().split('\n').filter(Boolean).forEach(row => state.accept(row));
  state.accept(line(threadSettings(secondId, 'gpt-6-luna')).slice(0, -3) + '\n');
  state.accept(line(context('gpt-6-luna')));
  state.accept(firstLegacyChildRequest());
  state.accept(line(threadSettings(secondId, 'gpt-6-luna')));
  state.accept(line(timedEvent(windowStart + 240_000, count(1200, 240, 140), count(50, 10, 20))));
  const period = state.periodSnapshot(currentWindow, observedNow);
  assert.equal(state.complete, false); assert.equal(state.forkAmbiguous, true);
  assert.equal(period?.complete, false); assert.equal(estimateUsd(period), null);
});

test('an unclassified skipped legacy prefix record blocks later resume-marker recovery after own usage', () => {
  for (const clearModel of [false, true]) {
    const state = new TokenLogState(windowStart);
    legacyForkPrefix().split('\n').filter(Boolean).forEach(row => state.accept(row));
    state.skipRecord(false, clearModel);
    state.accept(line(context('gpt-6-luna')));
    state.accept(firstLegacyChildRequest());
    state.accept(line(threadSettings(secondId, 'gpt-6-luna')));
    state.accept(line(timedEvent(windowStart + 240_000, count(1200, 240, 140), count(50, 10, 20))));
    const period = state.periodSnapshot(currentWindow, observedNow);
    assert.equal(state.complete, false); assert.equal(state.forkAmbiguous, true);
    assert.equal(period?.complete, false); assert.equal(estimateUsd(period), null);
  }
});

test('malformed missing-discriminator and unknown legacy prefix rows block later resume-marker recovery', () => {
  const rows = [
    '{"type":"event_msg","payload":{"ty\n',
    line({ type: 'unknown_rollout_type', payload: {} }),
    line({ type: 'unknown_rollout_type', payload: { type: 'thread_settings_applied', thread_id: secondId } }),
  ];
  for (const row of rows) {
    const state = new TokenLogState(windowStart);
    legacyForkPrefix().split('\n').filter(Boolean).forEach(prefix => state.accept(prefix));
    state.accept(row);
    state.accept(line(context('gpt-6-luna')));
    state.accept(firstLegacyChildRequest());
    state.accept(line(threadSettings(secondId, 'gpt-6-luna')));
    state.accept(line(timedEvent(windowStart + 240_000, count(1200, 240, 140), count(50, 10, 20))));
    const period = state.periodSnapshot(currentWindow, observedNow);
    assert.equal(state.complete, false); assert.equal(state.forkAmbiguous, true);
    assert.equal(period?.complete, false); assert.equal(estimateUsd(period), null);
  }
});

test('valid official legacy prefix rows and ordinary nested discriminators still permit recovery', () => {
  const state = new TokenLogState(windowStart);
  legacyForkPrefix().split('\n').filter(Boolean).forEach(row => state.accept(row));
  state.accept(line({ type: 'response_item', payload: { content: 'ordinary content' } }));
  state.accept(line({ type: 'response_item', payload: { type: 'thread_settings_applied', thread_id: secondId, nested: { type: 'token_count' } } }));
  for (const type of ['world_state', 'inter_agent_communication_metadata', 'token_usage_record']) {
    state.accept(line({ type, payload: { dummy: true } }));
  }
  state.accept(line(threadSettings(secondId, 'gpt-6-luna')));
  state.accept(firstLegacyChildRequest());
  const period = state.periodSnapshot(currentWindow, observedNow);
  assert.equal(state.snapshot()?.totalTokens, 60); assert.equal(state.complete, true); assert.equal(state.forkAmbiguous, false);
  assert.equal(period?.totalTokens, 60); assert.equal(period?.complete, true);
  assert.ok(Math.abs(estimateUsd(period)! - 0.0000082) < 1e-15);
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

test('an oversized known ordinary inherited record still permits legacy ownership-marker recovery', async () => {
  const f = await accountFixture();
  try {
    const log = legacyForkPrefix() + line({ type: 'response_item', payload: { content: largeDummyText } }) +
      line(threadSettings(secondId, 'gpt-6-luna')) + firstLegacyChildRequest();
    await writeFile(join(f.active, `rollout-legacy-ordinary-large-${secondId}.jsonl`), log);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.account?.totalTokens, 60); assert.equal(result.account?.complete, true);
    assert.equal(result.period?.totalTokens, 60); assert.equal(result.period?.complete, true);
    assert.equal(result.periodErrorCode, null); assert.ok(Math.abs(estimateUsd(result.period)! - 0.0000082) < 1e-15);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const sourceRolloutId = 'aaaaaaaa-1111-2222-3333-444444444444';
const branchRolloutId = 'bbbbbbbb-1111-2222-3333-444444444444';
const continuationRolloutId = 'cccccccc-1111-2222-3333-444444444444';
const referenceSource = (sessionId = id, accountId = 'account-a') => {
  const rows = [
    { type: 'session_meta', payload: { id: sessionId, creator_account_id: accountId, history_mode: 'paginated' } },
    context(),
    { type: 'response_item', payload: { dummy: 'UTF-8 界線' } },
    timedEvent(windowStart + 60_000, count(100, 20)),
  ];
  const prefix = rows.map((row, ordinal) => line({ ordinal, ...row })).join('');
  const next = line({ ordinal: rows.length, ...timedEvent(windowStart + 120_000, count(150, 30), count(50, 10)) });
  return { prefix, full: prefix + next, prefixBytes: Buffer.byteLength(prefix), prefixRows: rows.length };
};
type HistoryReference = { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number };
const referenceTo = (source: ReturnType<typeof referenceSource>, rolloutId = sourceRolloutId): HistoryReference => ({
  thread_id: rolloutId, end_ordinal_exclusive: source.prefixRows, end_byte_offset: source.prefixBytes,
});
const referencePath = (directory: string, canonicalId: string, rolloutId: string, label = 'synthetic') =>
  join(directory, `rollout-${label}-${canonicalId}_${rolloutId}.jsonl`);
const referencedLog = (history: HistoryReference, canonicalId = id, request = count(30, 6), total = count(130, 26), extraMeta: object = {}) => {
  const rows = [
    { type: 'session_meta', payload: { id: canonicalId, creator_account_id: 'account-a', history_mode: 'paginated', history_base: history, ...extraMeta } },
    context(), timedEvent(windowStart + 180_000, total, request),
  ];
  const full = rows.map((row, index) => line({ ordinal: history.end_ordinal_exclusive + index, ...row })).join('');
  return { full, rows: rows.length, endOrdinal: history.end_ordinal_exclusive + rows.length, bytes: Buffer.byteLength(full) };
};

test('paginated referenced rollouts use exact byte and ordinal cutoffs and retain both sides of a same-thread rollback', async () => {
  const f = await accountFixture();
  try {
    const source = referenceSource(), history = referenceTo(source, id);
    await writeFile(join(f.active, `rollout-synthetic-${id}.jsonl`), source.full);
    await writeFile(referencePath(f.active, id, branchRolloutId), referencedLog(history).full);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    for (const snapshot of [result.account, result.period]) {
      assert.equal(snapshot?.totalTokens, 216); assert.equal(snapshot?.inputTokens, 180);
      assert.equal(snapshot?.outputTokens, 36); assert.equal(snapshot?.sessionCount, 1);
      assert.equal(snapshot?.complete, true); assert.ok(Math.abs(estimateUsd(snapshot)! - 0.00072) < 1e-15);
    }
    assert.equal(result.errorCode, null); assert.equal(result.periodErrorCode, null);
    assert.deepEqual(await f.reader.read('account-a', currentWindow, observedNow), result);
    assert.ok(source.prefixBytes > source.prefix.length); // The cutoff is UTF-8 bytes, not string characters.
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('referenced forks count only their own suffix while physical active/archive copies are deduplicated', async () => {
  const f = await accountFixture();
  try {
    const source = referenceSource();
    const child = referencedLog(referenceTo(source), secondId, count(30, 6), count(130, 26), { forked_from_id: id });
    for (const directory of [f.active, f.archived]) {
      await writeFile(referencePath(directory, id, sourceRolloutId), source.full);
      await writeFile(referencePath(directory, secondId, branchRolloutId), child.full);
    }
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.account?.totalTokens, 216); assert.equal(result.account?.sessionCount, 2);
    assert.equal(result.period?.totalTokens, 216); assert.equal(result.period?.sessionCount, 2);
    assert.equal(result.account?.complete, true); assert.equal(result.period?.complete, true);
    assert.ok(Math.abs(estimateUsd(result.period)! - 0.00072) < 1e-15);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('distinct physical referenced requests with identical token evidence are both counted', async () => {
  const f = await accountFixture();
  try {
    const source = referenceSource();
    const target = referencedLog(referenceTo(source), id, count(50, 10), count(150, 30));
    const identical = target.full.replace(new Date(windowStart + 180_000).toISOString(), new Date(windowStart + 120_000).toISOString());
    await writeFile(referencePath(f.active, id, sourceRolloutId), source.full);
    await writeFile(referencePath(f.active, id, branchRolloutId), identical);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.account?.totalTokens, 240); assert.equal(result.period?.totalTokens, 240);
    assert.equal(result.period?.complete, true); assert.ok(Math.abs(estimateUsd(result.period)! - 0.0008) < 1e-15);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a referenced counter reset is priced only when the complete first request proves its new baseline', async () => {
  const f = await accountFixture();
  try {
    const source = referenceSource(), targetPath = referencePath(f.active, id, branchRolloutId);
    await writeFile(referencePath(f.active, id, sourceRolloutId), source.full);
    await writeFile(targetPath, referencedLog(referenceTo(source), id, count(30, 6), count(30, 6)).full);
    const reset = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(reset.account?.totalTokens, 216); assert.equal(reset.period?.totalTokens, 216);
    assert.equal(reset.period?.complete, true); assert.ok(Math.abs(estimateUsd(reset.period)! - 0.00072) < 1e-15);
    await writeFile(targetPath, referencedLog(referenceTo(source), id, count(10, 2), count(130, 26)).full);
    const ambiguous = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(ambiguous.period?.complete, false); assert.equal(estimateUsd(ambiguous.period), null);
    assert.equal(ambiguous.periodErrorCode, 'period_logs_incomplete');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('unsafe or unavailable referenced prefixes withhold current-period pricing', async t => {
  const variants = [
    'missing source', 'truncated source', 'foreign owner', 'filename owner mismatch', 'bad source ordinal',
    'missing source metadata', 'bad source metadata ordinal',
    'offset inside record', 'offset beyond file', 'character offset', 'negative offset', 'fractional offset',
    'wrong cutoff ordinal', 'negative cutoff ordinal', 'fractional cutoff ordinal', 'invalid physical ID', 'unknown history mode', 'symlink source',
    'bad target ordinal', 'missing target ordinal', 'duplicate target ordinal', 'conflicting physical prefix copies',
    'duplicate metadata ordinal', 'duplicate metadata type', 'duplicate metadata payload',
  ];
  for (const variant of variants) await t.test(variant, async () => {
    const f = await accountFixture();
    try {
      const source = referenceSource();
      let sourceText = source.full;
      const history = referenceTo(source), sourcePath = referencePath(f.active, id, sourceRolloutId);
      const extraMeta: Record<string, unknown> = {};
      if (variant === 'truncated source') sourceText = source.prefix.slice(0, -1);
      if (variant === 'foreign owner') sourceText = referenceSource(id, 'account-b').full;
      if (variant === 'filename owner mismatch') sourceText = referenceSource(secondId).full;
      if (variant === 'bad source ordinal') sourceText = sourceText.replace('"ordinal":3', '"ordinal":9');
      if (variant === 'missing source metadata') {
        const metadataBytes = Buffer.byteLength(sourceText.slice(0, sourceText.indexOf('\n') + 1));
        sourceText = sourceText.slice(sourceText.indexOf('\n') + 1); history.end_byte_offset -= metadataBytes;
      }
      if (variant === 'bad source metadata ordinal') sourceText = sourceText.replace('"ordinal":0', '"ordinal":1');
      if (variant === 'offset inside record') history.end_byte_offset--;
      if (variant === 'offset beyond file') history.end_byte_offset = Buffer.byteLength(source.full) + 1;
      if (variant === 'character offset') history.end_byte_offset = source.prefix.length;
      if (variant === 'negative offset') history.end_byte_offset = -1;
      if (variant === 'fractional offset') history.end_byte_offset += 0.5;
      if (variant === 'wrong cutoff ordinal') history.end_ordinal_exclusive++;
      if (variant === 'negative cutoff ordinal') history.end_ordinal_exclusive = -1;
      if (variant === 'fractional cutoff ordinal') history.end_ordinal_exclusive += 0.5;
      if (variant === 'invalid physical ID') history.thread_id = '../outside';
      if (variant === 'unknown history mode') extraMeta.history_mode = 'unknown';
      if (variant === 'symlink source') {
        const outside = join(f.root, 'outside-source.jsonl');
        await writeFile(outside, sourceText); await symlink(outside, sourcePath);
      } else if (variant !== 'missing source') await writeFile(sourcePath, sourceText);
      if (variant === 'conflicting physical prefix copies') {
        const conflicting = source.full.replaceAll(JSON.stringify(count(100, 20)), JSON.stringify(count(110, 22)))
          .replace(JSON.stringify(count(50, 10)), JSON.stringify(count(40, 8)));
        await writeFile(referencePath(f.archived, id, sourceRolloutId), conflicting);
      }
      let target = referencedLog(history, id, count(30, 6), count(130, 26), extraMeta).full;
      if (variant === 'bad target ordinal') target = target.replace('"ordinal":4', '"ordinal":6');
      if (variant === 'missing target ordinal') target = target.replace('"ordinal":4,', '');
      if (variant === 'duplicate target ordinal') target = target.replace('"ordinal":5', '"ordinal":4');
      if (variant === 'duplicate metadata ordinal') target = target.replace('"ordinal":4,', '"ordinal":4,"ordinal":4,');
      if (variant === 'duplicate metadata type') target = target.replace('"type":"session_meta",', '"type":"session_meta","type":"session_meta",');
      if (variant === 'duplicate metadata payload') target = target.replace('"payload":', '"payload":{},"payload":');
      await writeFile(referencePath(f.active, id, branchRolloutId), target);
      const result = await f.reader.read('account-a', currentWindow, observedNow);
      assert.notEqual(result.period?.complete, true); assert.equal(estimateUsd(result.period), null);
      assert.notEqual(result.periodErrorCode, null);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});

test('referenced prefix cycles do not recurse indefinitely or publish a partial price', async () => {
  const f = await accountFixture();
  try {
    const cycleMeta = (physicalId: string) => line({ ordinal: 2, type: 'session_meta', payload: {
      id, creator_account_id: 'account-a', history_mode: 'paginated',
      history_base: { thread_id: physicalId, end_ordinal_exclusive: 2, end_byte_offset: 1 },
    } });
    let first = cycleMeta(branchRolloutId), second = cycleMeta(sourceRolloutId);
    // Stabilize each metadata byte boundary without using a path as reference data.
    for (let index = 0; index < 4; index++) {
      first = first.replace(/"end_byte_offset":\d+/, `"end_byte_offset":${Buffer.byteLength(second)}`);
      second = second.replace(/"end_byte_offset":\d+/, `"end_byte_offset":${Buffer.byteLength(first)}`);
    }
    await writeFile(referencePath(f.active, id, sourceRolloutId), first);
    await writeFile(referencePath(f.active, id, branchRolloutId), second + line({ ordinal: 3, ...context() }) +
      line({ ordinal: 4, ...timedEvent(windowStart + 180_000, count(30, 6)) }));
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.notEqual(result.period?.complete, true); assert.equal(estimateUsd(result.period), null);
    assert.notEqual(result.periodErrorCode, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('reference continuations follow incremental appends and recursively referenced new physical pages', async () => {
  const f = await accountFixture();
  try {
    const source = referenceSource(), branch = referencedLog(referenceTo(source));
    const sourcePath = referencePath(f.active, id, sourceRolloutId), branchPath = referencePath(f.active, id, branchRolloutId);
    await writeFile(sourcePath, source.full); await writeFile(branchPath, branch.full);
    assert.equal((await f.reader.read('account-a', currentWindow, observedNow)).period?.totalTokens, 216);
    const next = line({ ordinal: branch.endOrdinal, ...timedEvent(windowStart + 240_000, count(140, 28), count(10, 2)) });
    await appendFile(branchPath, next.slice(0, -2));
    assert.equal((await f.reader.read('account-a', currentWindow, observedNow)).period?.totalTokens, 216);
    await appendFile(branchPath, next.slice(-2));
    const appended = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(appended.period?.totalTokens, 228); assert.equal(appended.period?.complete, true);
    const nested: HistoryReference = { thread_id: branchRolloutId, end_ordinal_exclusive: branch.endOrdinal, end_byte_offset: branch.bytes };
    const continuation = referencedLog(nested, id, count(20, 4), count(150, 30));
    await writeFile(referencePath(f.active, id, continuationRolloutId), continuation.full);
    const added = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(added.account?.totalTokens, 252); assert.equal(added.period?.totalTokens, 252);
    assert.equal(added.period?.sessionCount, 1); assert.equal(added.period?.complete, true);
    assert.ok(Math.abs(estimateUsd(added.period)! - 0.00084) < 1e-15);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a referenced baseline is revalidated after its source prefix changes', async () => {
  const f = await accountFixture();
  try {
    const source = referenceSource(), sourcePath = referencePath(f.active, id, sourceRolloutId);
    await writeFile(sourcePath, source.full);
    await writeFile(referencePath(f.active, id, branchRolloutId), referencedLog(referenceTo(source)).full);
    assert.equal((await f.reader.read('account-a', currentWindow, observedNow)).period?.complete, true);
    const replacement = source.full.replaceAll(JSON.stringify(count(100, 20)), JSON.stringify(count(101, 20)))
      .replace(JSON.stringify(count(50, 10)), JSON.stringify(count(49, 10)));
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(source.full));
    await writeFile(sourcePath, replacement);
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.period?.complete, false); assert.equal(estimateUsd(result.period), null);
    assert.equal(result.periodErrorCode, 'period_logs_incomplete');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('paginated roots reject duplicate metadata fields and invalid serialized ordinals', async t => {
  for (const variant of ['duplicate ordinal', 'duplicate type', 'duplicate payload', 'missing ordinal', 'nonzero first ordinal', 'fractional ordinal', 'later ordinal gap', 'leading ordinary record', 'leading blank record']) {
    await t.test(variant, async () => {
      const f = await accountFixture();
      try {
        let source = referenceSource().full;
        if (variant === 'duplicate ordinal') source = source.replace('"ordinal":0,', '"ordinal":0,"ordinal":0,');
        if (variant === 'duplicate type') source = source.replace('"type":"session_meta",', '"type":"session_meta","type":"session_meta",');
        if (variant === 'duplicate payload') source = source.replace('"payload":', '"payload":{},"payload":');
        if (variant === 'missing ordinal') source = source.replace('"ordinal":0,', '');
        if (variant === 'nonzero first ordinal') source = source.replace('"ordinal":0', '"ordinal":1');
        if (variant === 'fractional ordinal') source = source.replace('"ordinal":3', '"ordinal":3.5');
        if (variant === 'later ordinal gap') source = source.replace('"ordinal":1', '"ordinal":2');
        if (variant === 'leading ordinary record') source = line({ ordinal: 0, type: 'response_item', payload: { dummy: true } }) + source;
        if (variant === 'leading blank record') source = '\n' + source;
        await writeFile(referencePath(f.active, id, sourceRolloutId), source);
        const result = await f.reader.read('account-a', currentWindow, observedNow);
        assert.notEqual(result.period?.complete, true); assert.equal(estimateUsd(result.period), null);
        assert.notEqual(result.periodErrorCode, null);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }
});

test('referenced ownership is checked for each target even when its source baseline was already cached', async () => {
  const f = await accountFixture();
  try {
    const source = referenceSource(secondId), history = referenceTo(source);
    const firstTarget = referencePath(f.active, id, branchRolloutId);
    const secondTarget = referencePath(f.active, otherId, continuationRolloutId);
    await writeFile(referencePath(f.active, secondId, sourceRolloutId), source.full);
    await writeFile(firstTarget, referencedLog(history).full);
    const undeclaredFork = await f.reader.read('account-a', currentWindow, observedNow);
    assert.notEqual(undeclaredFork.period?.complete, true); assert.equal(estimateUsd(undeclaredFork.period), null);
    await writeFile(firstTarget, referencedLog(history, id, count(30, 6), count(130, 26), { forked_from_id: secondId }).full);
    const validFork = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(validFork.period?.totalTokens, 216); assert.equal(validFork.period?.complete, true);
    await writeFile(secondTarget, referencedLog(history, otherId).full);
    const cachedUndeclaredFork = await f.reader.read('account-a', currentWindow, observedNow);
    assert.notEqual(cachedUndeclaredFork.period?.complete, true); assert.equal(estimateUsd(cachedUndeclaredFork.period), null);
    await writeFile(secondTarget, referencedLog(history, otherId, count(30, 6), count(130, 26), { forked_from_id: id }).full);
    const wrongParent = await f.reader.read('account-a', currentWindow, observedNow);
    assert.notEqual(wrongParent.period?.complete, true); assert.equal(estimateUsd(wrongParent.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('legacy copies mixed with trusted physical suffixes cannot create a complete double-counted price', async () => {
  const f = await accountFixture();
  try {
    const source = referenceSource();
    const legacyPath = join(f.archived, `rollout-legacy-copy-${id}.jsonl`);
    await writeFile(referencePath(f.active, id, sourceRolloutId), source.full);
    await writeFile(referencePath(f.active, id, branchRolloutId), referencedLog(referenceTo(source)).full);
    const legacy = source.full.split('\n').filter(Boolean).map(text => {
      const { ordinal, ...row } = JSON.parse(text);
      if (row.type === 'session_meta') delete row.payload.history_mode;
      return line(row);
    }).join('');
    await writeFile(legacyPath, legacy);
    const copy = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(copy.account?.complete, false); assert.equal(copy.period?.complete, false);
    assert.equal(estimateUsd(copy.period), null);
    await writeFile(legacyPath, ownedMeta() + line(context()) + line(timedEvent(windowStart + 240_000, count(200, 40))));
    const unknownEvidence = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(unknownEvidence.account?.complete, false); assert.equal(unknownEvidence.period?.complete, false);
    assert.equal(estimateUsd(unknownEvidence.period), null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('overflow inside one canonical physical lineage cannot silently discard that lineage from account totals', async () => {
  const f = await accountFixture();
  try {
    const rows = [
      { type: 'session_meta', payload: { id, creator_account_id: 'account-a', history_mode: 'paginated' } },
      context(), timedEvent(windowStart + 60_000, count(Number.MAX_SAFE_INTEGER - 100, 0)),
    ];
    const source = rows.map((row, ordinal) => line({ ordinal, ...row })).join('');
    const history = { thread_id: sourceRolloutId, end_ordinal_exclusive: rows.length, end_byte_offset: Buffer.byteLength(source) };
    await writeFile(referencePath(f.active, id, sourceRolloutId), source);
    await writeFile(referencePath(f.active, id, branchRolloutId), referencedLog(history, id, count(200, 0), count(200, 0)).full);
    await writeFile(join(f.active, `rollout-small-${secondId}.jsonl`), session(secondId, 'account-a', 10, 0));
    const result = await f.reader.read('account-a', currentWindow, observedNow);
    assert.equal(result.account, null); assert.equal(result.errorCode, 'counter_overflow');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
