import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalTokenReader, TokenLogState, validThreadId } from '../src/local-tokens.ts';
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
