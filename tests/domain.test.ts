import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteTime, backoffMs, countdown, isOld, normalizeUsage, normalizeWindow, percentText, quotaState } from '../src/domain.ts';

test('percentages use remaining quota, keep decimals, and distinguish unknown values', () => {
  assert.equal(normalizeWindow({ usedPercent: 24 }, 'primary').remainingPercent, 76);
  assert.equal(normalizeWindow({ usedPercent: -5 }, 'primary').remainingPercent, 100);
  assert.equal(normalizeWindow({ usedPercent: 120 }, 'primary').remainingPercent, 0);
  for (const value of [null, undefined, '24', NaN, Infinity]) assert.equal(normalizeWindow({ usedPercent: value }, 'primary').remainingPercent, null);
  assert.equal(percentText(0.2), '<1%');
  assert.equal(percentText(76.9), '76%');
  assert.equal(percentText(null), '—');
  assert.equal(quotaState(30.01).label, '充足');
  assert.equal(quotaState(30).label, '額度偏低');
  assert.equal(quotaState(10).label, '接近上限');
  assert.equal(quotaState(0).label, '額度已用完');
  assert.equal(quotaState(90, 'rate_limit_reached').label, '已達使用上限');
});
test('multi-bucket view is authoritative and preserves slots without duplicating legacy data', () => {
  const snapshot = normalizeUsage({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1000 } }, other: { secondary: { usedPercent: 1, windowDurationMins: 10080 } },
  }, rateLimitResetCredits: { availableCount: 0 } }, 'plus', 123);
  assert.equal(snapshot.buckets.length, 2);
  assert.equal(snapshot.buckets[0].windows[0].remainingPercent, 76);
  assert.equal(snapshot.buckets[0].windows[0].label, '5 小時額度');
  assert.equal(snapshot.buckets[0].windows[0].resetsAtMs, 1000000);
  assert.equal(snapshot.buckets[0].windows[1].provided, false);
  assert.equal(snapshot.buckets[1].windows[1].label, '每週額度');
  assert.equal(snapshot.resetCreditsAvailable, 0);
  assert.equal(normalizeUsage({ rateLimits: {}, rateLimitsByLimitId: {} }, 'plus', 1).buckets.length, 0);
  assert.equal(normalizeUsage({ rateLimits: { primary: null }, rateLimitsByLimitId: null }, 'plus', 1).buckets.length, 1);
});
test('invalid reset timestamps remain unknown, and reset boundary never implies refilled quota', () => {
  for (const value of [null, undefined, '123', Infinity, -1, 1e20]) assert.equal(normalizeWindow({ resetsAt: value }, 'primary').resetsAtMs, null);
  assert.equal(countdown(null, 1000), '重置時間未提供');
  assert.equal(countdown(1000, 1000), '正在確認重置…');
  assert.equal(countdown(31000, 1000), '即將重置');
  assert.equal(countdown(121000, 1000), '2 分後重置');
  assert.equal(countdown(8_041_000, 1000), '2 小時 14 分後重置');
  const midnight = Date.parse('2026-10-08T16:05:00Z');
  assert.match(absoluteTime(midnight, 'Asia/Taipei'), /10\/09.*00:05/);
  assert.match(absoluteTime(midnight, 'UTC'), /10\/08.*16:05/);
});
test('freshness uses successful fetch time and retry delay is bounded', () => {
  const s = normalizeUsage({ rateLimits: {} }, 'plus', 1000);
  assert.equal(isOld(s, 121000), false);
  assert.equal(isOld(s, 121001), true);
  assert.equal(isOld({ ...s, status: 'offline' }, 1100), true);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => backoffMs(n, () => 0)), [15000, 30000, 60000, 120000, 300000, 300000]);
  assert.equal(backoffMs(5, () => 1), 300000);
});
