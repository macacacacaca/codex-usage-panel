import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, AdapterError } from '../src/adapter.ts';
import { UsageService } from '../src/service.ts';
import type { ChatTokens } from '../src/tokens.ts';

class FakeAdapter extends CodexAdapter {
  reads = 0; rates = 0; closes = 0;
  email: string | null = 'test@example.com'; accountId: string | null = 'account-a';
  failure: string | null = null; type = 'chatgpt'; gate: Promise<void> | null = null;
  onRate: (() => void) | null = null;
  failAfter = false;
  tokenFailure = false; tokenReads = 0;
  override async start() {}
  override async close() { this.closes++; }
  override async request(method: string): Promise<any> {
    if (method === 'account/read') {
      this.reads++;
      if (this.failAfter && this.reads % 2 === 0) throw new AdapterError('timeout');
      return { account: this.type === 'signed_out' ? null : { type: this.type, email: this.email, planType: 'plus' } };
    }
    if (method === 'account/usage/read') {
      this.tokenReads++; if (this.tokenFailure) throw new AdapterError('timeout');
      return { summary: { lifetimeTokens: this.accountId === 'account-b' ? 200 : 100 }, dailyUsageBuckets: [{ startDate: '2026-10-07', tokens: 10 }] };
    }
    this.rates++;
    if (this.gate) await this.gate;
    this.onRate?.();
    if (this.failure) throw new AdapterError(this.failure);
    return { accountId: this.accountId, rateLimits: { primary: { usedPercent: 24, resetsAt: 1000, windowDurationMins: 300 } } };
  }
}

test('concurrent panels/manual refresh share one read, failures retain the verified snapshot, recovery resets backoff', async () => {
  const adapter = new FakeAdapter();
  let release!: () => void; adapter.gate = new Promise(resolve => release = resolve);
  let now = 1000; const service = new UsageService({ adapter, now: () => now, random: () => 0 });
  try {
    const first = service.refresh(), second = service.refresh(); assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve)); release(); await first;
    assert.equal(adapter.rates, 1); assert.equal(service.snapshot.buckets[0].windows[0].remainingPercent, 76);
    adapter.gate = null; adapter.failure = 'timeout'; now = 2000; await service.refresh();
    assert.equal(service.snapshot.status, 'offline'); assert.equal(service.snapshot.fetchedAtMs, 1000);
    assert.equal(service.snapshot.buckets[0].windows[0].remainingPercent, 76); assert.equal(service.snapshot.nextAttemptAtMs, 17000);
    adapter.failure = null; now = 3000; await service.refresh();
    assert.equal(service.snapshot.status, 'ready'); assert.equal(service.snapshot.fetchedAtMs, 3000); assert.equal(service.failures, 0);
    const serialized = JSON.stringify(service.getSnapshot());
    assert.equal(serialized.includes('test@example.com'), false); assert.equal(serialized.includes('account-a'), false);
  } finally { await service.close(); }
});
test('account change during a read discards the response and clears old snapshot', async () => {
  const adapter = new FakeAdapter(); const service = new UsageService({ adapter });
  try {
    await service.refresh();
    adapter.onRate = () => { adapter.email = 'other@example.com'; };
    await service.refresh();
    assert.equal(service.snapshot.status, 'checking'); assert.equal(service.snapshot.buckets.length, 0);
    adapter.onRate = null; adapter.accountId = 'account-b'; await service.refresh();
    assert.equal(service.snapshot.status, 'ready');
    adapter.accountId = null; await service.refresh();
    assert.equal(service.snapshot.errorCode, 'identity_unknown'); assert.equal(service.snapshot.buckets.length, 0);
  } finally { await service.close(); }
});
test('auth notification invalidates in-flight results; sign-out and unsupported auth hide previous numbers', async () => {
  const adapter = new FakeAdapter(); const service = new UsageService({ adapter });
  try {
    await service.refresh();
    adapter.onRate = () => { adapter.emit('account/updated', { authMode: null }); };
    await service.refresh(); assert.equal(service.snapshot.buckets.length, 0); assert.equal(service.snapshot.status, 'checking');
    adapter.onRate = null; adapter.type = 'signed_out'; await service.refresh();
    assert.equal(service.snapshot.status, 'signed_out'); assert.equal(service.snapshot.fetchedAtMs, null);
    adapter.type = 'apiKey'; await service.refresh(); assert.equal(service.snapshot.errorCode, 'unsupported_auth');
  } finally { await service.close(); }
});
test('unconfirmable auth clears cache even on network failure; polling follows visibility and selected interval', async () => {
  const adapter = new FakeAdapter(); let now = 1000; const service = new UsageService({ adapter, now: () => now });
  try {
    await service.refresh();
    service.setPanel('one', true, 60); service.setPanel('two', true, 30);
    assert.equal(service.pollInterval(), 30000);
    service.setPanel('two', false, 30); now += 60001;
    assert.equal(service.pollInterval(), 60000);
    service.setPanel('one', false, 60); now += 60001;
    assert.equal(service.pollInterval(), 300000);
    adapter.email = null; await service.refresh();
    assert.equal(service.snapshot.errorCode, 'identity_unknown'); assert.equal(service.snapshot.buckets.length, 0);
  } finally { await service.close(); }
  assert.equal(adapter.closes, 1); assert.equal(service.panels.size, 0);
});

test('reset boundary refetches once without refilling quota, and wake triggers a fresh read', async () => {
  const adapter = new FakeAdapter(); let now = 999_000;
  const service = new UsageService({ adapter, now: () => now });
  try {
    await service.refresh(); service.lastTick = now;
    now = 1_000_001; service.tick(); await service.inFlight;
    assert.equal(adapter.rates, 2);
    assert.equal(service.snapshot.buckets[0].windows[0].remainingPercent, 76);
    now += 10000; service.tick(); assert.equal(adapter.rates, 2);
    now += 90000; service.tick(); await service.inFlight; assert.equal(adapter.rates, 3);
    await service.close(); now += 90000; service.tick(); assert.equal(adapter.rates, 3);
  } finally { await service.close(); }
});

test('identity verification failure after usage read clears data; disconnected process uses backoff', async () => {
  const adapter = new FakeAdapter(); let now = 1000;
  const service = new UsageService({ adapter, now: () => now, random: () => 0 });
  try {
    await service.refresh(); adapter.failAfter = true; now = 2000;
    await service.refresh(); assert.equal(service.snapshot.buckets.length, 0);
    adapter.failAfter = false;
    adapter.onRate = () => adapter.emit('disconnected', 'service_stopped');
    now = 3000; await service.refresh();
    assert.equal(service.snapshot.status, 'offline');
    assert.equal(service.snapshot.nextAttemptAtMs, 33000);
    assert.equal(service.snapshot.buckets.length, 0);
  } finally { await service.close(); }
});

const trackedA = '11111111-2222-3333-4444-555555555555';
const trackedB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const fakeChat = (total: number): ChatTokens => ({ inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total, segments: [{ model: 'gpt-6.1-sol', longContext: false, inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total }], updatedAtMs: 1000, complete: true });
test('optional token history failure retains quota and same-account history, but an account switch clears it', async () => {
  const adapter = new FakeAdapter();
  const service = new UsageService({ adapter, trackingId: trackedA, localReader: { async read(_id, account) { return account === 'account-a' ? { chat: fakeChat(100), errorCode: null } : { chat: null, errorCode: 'log_identity_mismatch' }; } } });
  try {
    await service.refresh(); assert.equal(service.snapshot.tokens.lifetimeTokens, 100); assert.equal(service.snapshot.tokens.chat?.totalTokens, 100);
    adapter.tokenFailure = true; await service.refresh();
    assert.equal(service.snapshot.status, 'ready'); assert.equal(service.snapshot.tokens.lifetimeTokens, 100); assert.equal(service.snapshot.tokens.errorCode, 'timeout');
    adapter.email = 'other@example.com'; adapter.accountId = 'account-b'; await service.refresh();
    assert.equal(service.snapshot.status, 'ready'); assert.equal(service.snapshot.tokens.lifetimeTokens, null); assert.equal(service.snapshot.tokens.chat, null);
    adapter.emit('account/updated');
    assert.equal(service.snapshot.tokens.chat, null); assert.equal(service.snapshot.tokens.trackingId, trackedA);
  } finally { await service.close(); }
});
test('local polling does not request account history or change quota timestamp; tracking changes discard in-flight logs', async () => {
  const adapter = new FakeAdapter(); let now = 1000, total = 100, gate: Promise<void> | null = null;
  const service = new UsageService({ adapter, now: () => now, trackingId: trackedA, localReader: { async read(id) { if (gate) await gate; return { chat: fakeChat(id === trackedB ? 200 : total), errorCode: null }; } } });
  try {
    await service.refresh(); const reads = adapter.tokenReads;
    now = 11000; service.lastTick = 1000; total = 150; service.tick(); await service.localInFlight;
    assert.equal(service.snapshot.tokens.chat?.totalTokens, 150); assert.equal(service.snapshot.fetchedAtMs, 1000); assert.equal(adapter.tokenReads, reads);
    let release!: () => void; gate = new Promise(resolve => release = resolve);
    const reading = service.refreshLocalTokens(); const changing = service.setTrackingId(trackedB);
    assert.equal(service.snapshot.tokens.chat, null); release(); await reading; await changing; gate = null;
    assert.equal(service.snapshot.tokens.trackingId, trackedB); assert.equal(service.snapshot.tokens.chat?.totalTokens, 200);
    await service.setTrackingId(null); assert.equal(service.snapshot.tokens.trackingId, null);
  } finally { await service.close(); }
});
