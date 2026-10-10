import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counter, normalizeCounters, normalizeAccountTokens, estimateUsd, usdText, type ChatTokens, type TokenSegment } from '../src/tokens.ts';

const segment: TokenSegment = { model: 'gpt-6.1-sol', longContext: false, inputTokens: 1_000_000, cachedInputTokens: 600_000, cacheWriteInputTokens: 100_000, outputTokens: 100_000, reasoningOutputTokens: 70_000, totalTokens: 1_100_000 };
const chat: ChatTokens = { ...segment, segments: [segment], updatedAtMs: 1, complete: true };
test('USD uses uncached input, cached input, cache writes and output once; long context and Fast apply separately', () => {
  assert.ok(Math.abs(estimateUsd(chat)! - 1.91) < 1e-10);
  assert.ok(Math.abs(estimateUsd(chat, 'fast')! - 3.82) < 1e-10);
  assert.ok(Math.abs(estimateUsd({ ...chat, reasoningOutputTokens: 0 })! - 1.91) < 1e-10);
  const long = { ...segment, longContext: true };
  assert.ok(Math.abs(estimateUsd({ ...chat, segments: [long] })! - 3.32) < 1e-10);
  const luna = { ...segment, model: 'gpt-6-luna' };
  const mixed = { ...chat, totalTokens: 2_200_000, segments: [segment, luna] };
  assert.ok(Math.abs(estimateUsd(mixed)! - 2.0085) < 1e-10);
});
test('unknown model, incomplete coverage or unknown context cannot produce a dollar total', () => {
  assert.equal(estimateUsd(null), null);
  assert.equal(estimateUsd({ ...chat, complete: false }), null);
  assert.equal(estimateUsd({ ...chat, segments: [] }), null);
  assert.equal(estimateUsd({ ...chat, segments: [{ ...segment, model: 'unknown' }] }), null);
  assert.equal(estimateUsd({ ...chat, segments: [{ ...segment, longContext: null }] }), null);
  assert.equal(usdText(null), '—'); assert.equal(usdText(0), 'US$0.00'); assert.equal(usdText(.001), '< US$0.01');
});
test('token normalization preserves source dates, rejects unsafe totals and avoids duplicate-day sums', () => {
  assert.equal(counter(9007199254740992), null); assert.equal(counter('100'), null); assert.equal(counter(-1), null);
  assert.equal(counter(100n), 100); assert.equal(counter(9007199254740992n), null);
  const data = normalizeAccountTokens({ summary: { lifetimeTokens: 800 }, dailyUsageBuckets: [
    { startDate: '2026-10-07', tokens: 50 }, { startDate: '2026-10-06', tokens: 20 }, { startDate: '2026-10-07', tokens: 55 },
    { startDate: '2026-02-30', tokens: 20 }, { startDate: '2026-10-08T00:00:00Z', tokens: 20 }, { startDate: '2026-10-09', tokens: -1 },
  ] }, 123);
  assert.equal(data.lifetimeTokens, 800); assert.equal(data.fetchedAtMs, 123);
  assert.deepEqual(data.dailyBuckets, [{ date: '2026-10-06', tokens: 20 }, { date: '2026-10-07', tokens: 55 }]);
  const raw = { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120 };
  assert.equal(normalizeCounters(raw)?.totalTokens, 120);
  assert.equal(normalizeCounters({ ...raw, cache_write_input_tokens: -1 }), null);
  assert.equal(normalizeCounters({ ...raw, reasoning_output_tokens: 21 }), null);
  assert.equal(normalizeCounters({ ...raw, cached_input_tokens: 101 }), null);
  assert.equal(normalizeCounters({ ...raw, total_tokens: 121 }), null);
});
