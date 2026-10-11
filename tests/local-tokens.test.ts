import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, mkdir, rename, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountTokenReader, LocalTokenReader, TokenLogState, validThreadId } from '../src/local-tokens.ts';
import { estimateUsd } from '../src/tokens.ts';

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
