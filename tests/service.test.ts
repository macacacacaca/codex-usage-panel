import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, AdapterError } from '../src/adapter.ts';
import { UsageService } from '../src/service.ts';
import { nativePayload } from '../src/native.ts';
import type { AccountTokens, ChatTokens, TokenWindow, WindowTokens } from '../src/tokens.ts';

const emptyAccountReader = { async read() { return { account: null, errorCode: 'no_token_events' }; } };

class FakeAdapter extends CodexAdapter {
  reads = 0; rates = 0; closes = 0;
  email: string | null = 'test@example.com'; accountId: string | null | undefined = 'account-a';
  failure: string | null = null; type = 'chatgpt'; gate: Promise<void> | null = null;
  onRate: (() => void) | null = null;
  failAfter = false;
  tokenFailure = false; tokenReads = 0;
  quota: any = null;
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
    return { ...(this.accountId === undefined ? {} : { accountId: this.accountId }), ...(this.quota ?? { rateLimits: { primary: { usedPercent: 24, resetsAt: 1000, windowDurationMins: 300 } } }) };
  }
}

test('concurrent panels/manual refresh share one read, failures retain the verified snapshot, recovery resets backoff', async () => {
  const adapter = new FakeAdapter();
  let release!: () => void; adapter.gate = new Promise(resolve => release = resolve);
  let now = 1000; const service = new UsageService({ accountReader: emptyAccountReader, adapter, now: () => now, random: () => 0 });
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
  const adapter = new FakeAdapter(); const service = new UsageService({ accountReader: emptyAccountReader, adapter });
  try {
    await service.refresh();
    adapter.onRate = () => { adapter.email = 'other@example.com'; };
    await service.refresh();
    assert.equal(service.snapshot.status, 'checking'); assert.equal(service.snapshot.buckets.length, 0);
    adapter.onRate = null; adapter.accountId = 'account-b'; await service.refresh();
    assert.equal(service.snapshot.status, 'ready');
    adapter.accountId = null; await service.refresh();
    assert.equal(service.snapshot.status, 'ready'); assert.equal(service.snapshot.errorCode, null);
    assert.equal(service.snapshot.buckets[0].windows[0].remainingPercent, 76);
    assert.equal(service.sourceAccountId, null); assert.equal(service.snapshot.tokens.account, null);
  } finally { await service.close(); }
});
test('auth notification invalidates in-flight results; sign-out and unsupported auth hide previous numbers', async () => {
  const adapter = new FakeAdapter(); const service = new UsageService({ accountReader: emptyAccountReader, adapter });
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
  const adapter = new FakeAdapter(); let now = 1000; const service = new UsageService({ accountReader: emptyAccountReader, adapter, now: () => now });
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
  const service = new UsageService({ accountReader: emptyAccountReader, adapter, now: () => now });
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
  const service = new UsageService({ accountReader: emptyAccountReader, adapter, now: () => now, random: () => 0 });
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
const fakeAccount = (total: number, sessionCount = 1): AccountTokens => ({ ...fakeChat(total), sessionCount });
test('optional token history failure retains quota and same-account history, but an account switch clears it', async () => {
  const adapter = new FakeAdapter();
  const service = new UsageService({ accountReader: emptyAccountReader, adapter, trackingId: trackedA, localReader: { async read(_id, account) { return account === 'account-a' ? { chat: fakeChat(100), errorCode: null } : { chat: null, errorCode: 'log_identity_mismatch' }; } } });
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
  const service = new UsageService({ accountReader: emptyAccountReader, adapter, now: () => now, trackingId: trackedA, localReader: { async read(id) { if (gate) await gate; return { chat: fakeChat(id === trackedB ? 200 : total), errorCode: null }; } } });
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

test('account-wide local tokens update without a tracked chat or additional account API polling, and switch accounts safely', async () => {
  const adapter = new FakeAdapter(); let now = 1000, total = 40, sessionCount = 2;
  const accounts: string[] = []; let chatReads = 0;
  const service = new UsageService({ adapter, now: () => now,
    localReader: { async read() { chatReads++; return { chat: fakeChat(999), errorCode: null }; } },
    accountReader: { async read(accountId) { accounts.push(accountId); return { account: fakeAccount(accountId === 'account-a' ? total : 20, accountId === 'account-a' ? sessionCount : 1), errorCode: null }; } },
  });
  try {
    await service.refresh();
    assert.equal(service.snapshot.tokens.trackingId, null); assert.equal(service.snapshot.tokens.chat, null);
    assert.equal(service.snapshot.tokens.account?.totalTokens, 40); assert.equal(service.snapshot.tokens.account?.sessionCount, 2);
    assert.equal(service.snapshot.tokens.lifetimeTokens, 100); assert.equal(chatReads, 0);
    const apiReads = [adapter.reads, adapter.rates, adapter.tokenReads];
    now = 11000; service.lastTick = 1000; total = 75; sessionCount = 3; service.tick(); await service.localInFlight;
    assert.equal(service.snapshot.tokens.account?.totalTokens, 75);
    assert.equal(service.snapshot.tokens.account?.sessionCount, 3);
    assert.equal(service.snapshot.fetchedAtMs, 1000); assert.equal(service.snapshot.tokens.fetchedAtMs, 1000);
    assert.deepEqual([adapter.reads, adapter.rates, adapter.tokenReads], apiReads);
    const previous = service.getSnapshot();
    adapter.email = 'other@example.com'; adapter.accountId = 'account-b'; await service.refresh();
    assert.equal(service.snapshot.tokens.account?.totalTokens, 20); assert.equal(service.snapshot.tokens.lifetimeTokens, 200);
    assert.equal(service.snapshot.tokens.accountErrorCode, null); assert.equal(previous.tokens.account?.totalTokens, 75);
    assert.deepEqual(accounts, ['account-a', 'account-a', 'account-b']);
    adapter.type = 'signed_out'; await service.refresh();
    assert.equal(service.snapshot.status, 'signed_out'); assert.equal(service.snapshot.tokens.account, null);
    assert.equal(service.snapshot.tokens.lifetimeTokens, null);
  } finally { await service.close(); }
});

test('in-flight account aggregates cannot republish after an account switch or sign-out', async () => {
  const adapter = new FakeAdapter(); let gate: Promise<void> | null = null;
  let release = () => {}; let accountATotal = 40, accountBTotal = 20;
  const published: Array<number | null> = [];
  const service = new UsageService({ adapter,
    accountReader: { async read(accountId) {
      const account = fakeAccount(accountId === 'account-a' ? accountATotal : accountBTotal);
      if (gate) await gate;
      return { account, errorCode: null };
    } },
  });
  service.on('snapshot', snapshot => published.push(snapshot.tokens.account?.totalTokens ?? null));
  try {
    await service.refresh(); assert.equal(service.snapshot.tokens.account?.totalTokens, 40);
    gate = new Promise<void>(resolve => release = resolve); accountATotal = 500;
    const staleA = service.refreshLocalTokens(); await new Promise(resolve => setImmediate(resolve));
    adapter.email = 'other@example.com'; adapter.accountId = 'account-b';
    const switching = service.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.sourceAccountId, 'account-b'); assert.equal(service.snapshot.tokens.account, null);
    release(); gate = null; await staleA; await switching;
    assert.equal(service.snapshot.tokens.account?.totalTokens, 20); assert.equal(published.includes(500), false);

    gate = new Promise<void>(resolve => release = resolve); accountBTotal = 400;
    const staleB = service.refreshLocalTokens(); await new Promise(resolve => setImmediate(resolve));
    adapter.type = 'signed_out'; await service.refresh();
    assert.equal(service.snapshot.status, 'signed_out'); assert.equal(service.snapshot.tokens.account, null);
    release(); gate = null; await staleB;
    assert.equal(service.snapshot.tokens.account, null); assert.equal(published.includes(400), false);
  } finally { release(); gate = null; await service.close(); }
});

test('snapshots and injected reader results do not alias mutable account or chat token data', async () => {
  const adapter = new FakeAdapter(); const account = fakeAccount(40), chat = fakeChat(20);
  const service = new UsageService({ adapter, trackingId: trackedA,
    localReader: { async read() { return { chat, errorCode: null }; } },
    accountReader: { async read() { return { account, errorCode: null }; } },
  });
  try {
    const snapshot = await service.refresh();
    snapshot.tokens.account!.totalTokens = 999; snapshot.tokens.account!.segments[0].totalTokens = 999;
    snapshot.tokens.chat!.totalTokens = 999; snapshot.tokens.dailyBuckets[0].tokens = 999;
    snapshot.buckets[0].windows[0].remainingPercent = 0;
    account.totalTokens = 888; account.segments[0].totalTokens = 888;
    chat.totalTokens = 888; chat.segments[0].totalTokens = 888;
    const retained = service.getSnapshot();
    assert.equal(retained.tokens.account?.totalTokens, 40); assert.equal(retained.tokens.account?.segments[0].totalTokens, 40);
    assert.equal(retained.tokens.chat?.totalTokens, 20); assert.equal(retained.tokens.chat?.segments[0].totalTokens, 20);
    assert.equal(retained.tokens.dailyBuckets[0].tokens, 10); assert.equal(retained.buckets[0].windows[0].remainingPercent, 76);
  } finally { await service.close(); }
});

test('an account log read failure clears its aggregate without hiding verified quota or official history', async () => {
  const adapter = new FakeAdapter(); let unavailable = false;
  const service = new UsageService({ adapter,
    accountReader: { async read() {
      if (unavailable) throw new Error('unavailable');
      return { account: fakeAccount(40), errorCode: null };
    } },
  });
  try {
    await service.refresh(); unavailable = true; await service.refreshLocalTokens();
    assert.equal(service.snapshot.tokens.account, null); assert.equal(service.snapshot.tokens.accountErrorCode, 'log_unavailable');
    assert.equal(service.snapshot.status, 'ready'); assert.equal(service.snapshot.tokens.lifetimeTokens, 100);
    assert.equal(adapter.rates, 1); assert.equal(adapter.tokenReads, 1);
  } finally { await service.close(); }
});

const periodNow = Date.parse('2026-10-12T04:00:00Z');
const setCycle = (adapter: FakeAdapter, end: number) => {
  adapter.quota = { rateLimits: { limitId: 'codex', primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: end / 1000 } } };
};
const fakePeriod = (total: number, window: TokenWindow): WindowTokens => ({ ...fakeAccount(total), window: { ...window }, excludedReviewTokens: 0 });

test('verified quota works without a supplied account ID while local ownership remains unavailable', async () => {
  for (const accountId of [undefined, null, '', '   ']) {
    for (const tokenFailure of [false, true]) {
      const adapter = new FakeAdapter(); adapter.accountId = accountId; adapter.tokenFailure = tokenFailure;
      setCycle(adapter, periodNow + 2 * 60 * 60_000);
      let localReads = 0, accountReads = 0;
      const service = new UsageService({ adapter, trackingId: trackedA, now: () => periodNow,
        localReader: { async read() { localReads++; return { chat: fakeChat(999), errorCode: null }; } },
        accountReader: { async read(_account, window) {
          accountReads++;
          return { account: fakeAccount(999), errorCode: null, period: window ? fakePeriod(999, window) : null, periodErrorCode: null };
        } },
      });
      try {
        const snapshot = await service.refresh();
        assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.errorCode, null);
        assert.equal(snapshot.buckets[0].windows[0].remainingPercent, 76);
        assert.equal(service.sourceAccountId, null); assert.equal(service.failures, 0);
        assert.equal(snapshot.tokens.chat, null); assert.equal(snapshot.tokens.account, null); assert.equal(snapshot.tokens.period, null);
        assert.equal(snapshot.tokens.chatErrorCode, 'log_identity_mismatch');
        assert.equal(snapshot.tokens.accountErrorCode, 'log_identity_mismatch');
        assert.equal(snapshot.tokens.periodErrorCode, 'log_identity_mismatch');
        assert.equal(snapshot.tokens.lifetimeTokens, tokenFailure ? null : 100);
        assert.equal(snapshot.tokens.errorCode, tokenFailure ? 'timeout' : null);
        assert.equal(nativePayload(snapshot, periodNow).standardUsd, null);
        await service.refreshLocalTokens();
        assert.equal(localReads, 0); assert.equal(accountReads, 0);
      } finally { await service.close(); }
    }
  }
});

test('losing an account ID clears local counters and rejects delayed reads, then restores exact-account aggregation', async () => {
  const adapter = new FakeAdapter(); setCycle(adapter, periodNow + 2 * 60 * 60_000);
  let total = 40, gate: Promise<void> | null = null, release = () => {};
  const accounts: string[] = [], published: Array<Array<number | null>> = [];
  let localReads = 0;
  const service = new UsageService({ adapter, trackingId: trackedA, now: () => periodNow,
    localReader: { async read() {
      localReads++; const chat = fakeChat(total);
      if (gate) await gate;
      return { chat, errorCode: null };
    } },
    accountReader: { async read(accountId, window) {
      accounts.push(accountId); const account = fakeAccount(total), period = window ? fakePeriod(total, window) : null;
      if (gate) await gate;
      return { account, errorCode: null, period, periodErrorCode: null };
    } },
  });
  service.on('snapshot', snapshot => published.push([snapshot.tokens.chat?.totalTokens ?? null,
    snapshot.tokens.account?.totalTokens ?? null, snapshot.tokens.period?.totalTokens ?? null]));
  try {
    await service.refresh();
    assert.equal(service.snapshot.tokens.chat?.totalTokens, 40);
    assert.equal(service.snapshot.tokens.account?.totalTokens, 40);
    assert.equal(service.snapshot.tokens.period?.totalTokens, 40);
    const generation = service.tokenGeneration;
    gate = new Promise<void>(resolve => release = resolve); total = 900;
    const oldRead = service.refreshLocalTokens(); await new Promise(resolve => setImmediate(resolve));
    adapter.accountId = undefined;
    const missing = await service.refresh();
    assert.equal(missing.status, 'ready'); assert.equal(missing.errorCode, null);
    assert.equal(service.sourceAccountId, null); assert.ok(service.tokenGeneration > generation);
    assert.equal(missing.tokens.chat, null); assert.equal(missing.tokens.account, null); assert.equal(missing.tokens.period, null);
    assert.equal(missing.tokens.periodErrorCode, 'log_identity_mismatch');
    release(); gate = null; await oldRead;
    assert.equal(service.snapshot.tokens.chat, null); assert.equal(service.snapshot.tokens.account, null); assert.equal(service.snapshot.tokens.period, null);
    assert.equal(published.some(values => values.includes(900)), false);
    const reads = [localReads, accounts.length];
    await service.refresh(); await service.refreshLocalTokens();
    assert.deepEqual([localReads, accounts.length], reads);
    adapter.accountId = 'account-b'; total = 20;
    await service.refresh();
    assert.equal(service.sourceAccountId, 'account-b'); assert.equal(service.snapshot.status, 'ready');
    assert.equal(service.snapshot.tokens.chat?.totalTokens, 20);
    assert.equal(service.snapshot.tokens.account?.totalTokens, 20);
    assert.equal(service.snapshot.tokens.period?.totalTokens, 20);
    assert.equal(service.snapshot.tokens.chatErrorCode, null); assert.equal(service.snapshot.tokens.accountErrorCode, null);
    assert.equal(service.snapshot.tokens.periodErrorCode, null);
    assert.deepEqual(accounts, ['account-a', 'account-a', 'account-b']);
  } finally { release(); gate = null; await service.close(); }
});

test('an account change during a quota read without an account ID still discards unverified data', async () => {
  const adapter = new FakeAdapter(); adapter.accountId = undefined;
  setCycle(adapter, periodNow + 2 * 60 * 60_000);
  const service = new UsageService({ adapter, accountReader: emptyAccountReader, now: () => periodNow });
  try {
    await service.refresh(); assert.equal(service.snapshot.status, 'ready');
    adapter.onRate = () => { adapter.email = 'other@example.com'; };
    await service.refresh();
    assert.equal(service.snapshot.status, 'checking'); assert.equal(service.snapshot.buckets.length, 0);
    assert.equal(service.snapshot.tokens.lifetimeTokens, null); assert.equal(service.snapshot.tokens.period, null);
    adapter.onRate = null; await service.refresh();
    assert.equal(service.snapshot.status, 'ready'); assert.equal(service.snapshot.errorCode, null);
    adapter.email = null; await service.refresh();
    assert.equal(service.snapshot.errorCode, 'identity_unknown'); assert.equal(service.snapshot.buckets.length, 0);
  } finally { await service.close(); }
});

test('native currency and local polling use only current-cycle tokens, never account or lifetime totals', async () => {
  const adapter = new FakeAdapter(); let now = periodNow, total = 100;
  setCycle(adapter, now + 2 * 60 * 60_000);
  const reads: Array<{ window: TokenWindow | null | undefined; now: number | undefined }> = [];
  const service = new UsageService({ adapter, now: () => now, accountReader: { async read(_account, window, observedNow) {
    reads.push({ window, now: observedNow });
    return { account: fakeAccount(100_000_000), errorCode: null, period: window ? fakePeriod(total, window) : null, periodErrorCode: null };
  } } });
  try {
    await service.refresh();
    assert.equal(service.snapshot.tokens.period?.totalTokens, 100);
    assert.equal(service.getSnapshot().tokens.periodErrorCode, null);
    assert.equal(nativePayload(service.getSnapshot(), now).standardUsd, .0002);
    assert.deepEqual(reads[0], { window: { startAtMs: periodNow - 3 * 60 * 60_000, endAtMs: periodNow + 2 * 60 * 60_000, windowMinutes: 300 }, now: periodNow });
    const upstreamReads = [adapter.reads, adapter.rates, adapter.tokenReads];
    total = 250; now += 10_000; service.lastTick = now - 10_000; service.tick(); await service.localInFlight;
    assert.equal(service.getSnapshot().tokens.period?.totalTokens, 250);
    assert.equal(nativePayload(service.getSnapshot(), now).standardUsd, .0005);
    assert.deepEqual([adapter.reads, adapter.rates, adapter.tokenReads], upstreamReads);
    const clone = service.getSnapshot(); clone.tokens.period!.window.endAtMs = 0; clone.tokens.period!.totalTokens = 0;
    assert.equal(service.getSnapshot().tokens.period?.totalTokens, 250);
    const boundary = service.snapshot.tokens.period!.window.endAtMs;
    now = boundary;
    assert.equal(service.getSnapshot().tokens.period, null);
    assert.equal(service.getSnapshot().tokens.periodErrorCode, 'window_expired');
    assert.equal(nativePayload(service.snapshot, now).standardUsd, null);
    setCycle(adapter, boundary + 18_000_000); total = 0; await service.refresh();
    assert.equal(service.getSnapshot().tokens.period?.totalTokens, 0);
    assert.equal(service.getSnapshot().tokens.period?.window.startAtMs, boundary);
    assert.equal(nativePayload(service.getSnapshot(), now).standardUsd, 0);
  } finally { await service.close(); }
});
test('a delayed previous-cycle read cannot publish after an official cycle change', async () => {
  const adapter = new FakeAdapter(); const now = periodNow; const end = now + 60_000; let oldTotal = 40;
  setCycle(adapter, end);
  let release = () => {}, gate: Promise<void> | null = null;
  const published: Array<number | null> = [];
  const service = new UsageService({ adapter, now: () => now, accountReader: { async read(_account, window) {
    const captured = window && fakePeriod(window.endAtMs === end ? oldTotal : 20, window);
    if (gate) await gate;
    return { account: fakeAccount(1000), errorCode: null, period: captured, periodErrorCode: null };
  } } });
  service.on('snapshot', s => published.push(s.tokens.period?.totalTokens ?? null));
  try {
    await service.refresh(); published.length = 0;
    oldTotal = 999;
    gate = new Promise<void>(resolve => release = resolve);
    const pending = service.refreshLocalTokens(); await new Promise(resolve => setImmediate(resolve));
    setCycle(adapter, end + 60_000);
    const refreshing = service.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.getSnapshot().tokens.period, null);
    release(); gate = null; await pending; await refreshing;
    assert.equal(service.getSnapshot().tokens.period?.totalTokens, 20);
    assert.equal(published.includes(999), false);
  } finally { release(); gate = null; await service.close(); }
});
test('missing interval, mismatched result or incomplete logs never fall back to lifetime currency', async () => {
  const adapter = new FakeAdapter(); let wrongWindow = false, unavailable = false;
  setCycle(adapter, periodNow + 60_000);
  const service = new UsageService({ adapter, now: () => periodNow, accountReader: { async read(_account, window) {
    return { account: fakeAccount(1_000_000), errorCode: null,
      period: unavailable ? null : window ? { ...fakePeriod(100, { ...window, endAtMs: window.endAtMs + (wrongWindow ? 1000 : 0) }), complete: false } : null,
      periodErrorCode: unavailable ? 'log_unavailable' : 'period_logs_incomplete' };
  } } });
  try {
    await service.refresh();
    assert.equal(service.getSnapshot().tokens.period?.totalTokens, 100);
    assert.equal(service.getSnapshot().tokens.periodErrorCode, 'period_logs_incomplete');
    assert.equal(nativePayload(service.getSnapshot(), periodNow).standardUsd, null);
    wrongWindow = true; await service.refreshLocalTokens();
    assert.equal(service.getSnapshot().tokens.period, null);
    unavailable = true; await service.refreshLocalTokens();
    assert.equal(service.getSnapshot().tokens.periodErrorCode, 'log_unavailable');
    adapter.quota = { rateLimitsByLimitId: { other: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: (periodNow + 60_000) / 1000 } } } };
    await service.refresh();
    assert.equal(service.getSnapshot().tokens.period, null);
    assert.equal(service.getSnapshot().tokens.periodErrorCode, 'window_unavailable');
    assert.equal(nativePayload(service.getSnapshot(), periodNow).standardUsd, null);
  } finally { await service.close(); }
});

test('native pricing explains unlisted models without misclassifying complete token data', async () => {
  const adapter = new FakeAdapter(); setCycle(adapter, periodNow + 60_000);
  const service = new UsageService({ adapter, now: () => periodNow, accountReader: { async read(_account, window) {
    const period = window ? fakePeriod(100, window) : null;
    if (period) period.segments[0].model = 'unlisted-model';
    return { account: fakeAccount(100), errorCode: null, period, periodErrorCode: null };
  } } });
  try {
    await service.refresh();
    const payload = nativePayload(service.getSnapshot(), periodNow);
    assert.equal(payload.snapshot.tokens.period?.complete, true);
    assert.equal(payload.standardUsd, null);
    assert.equal(payload.standardUsdReason, 'unknown_model');
    assert.equal(nativePayload(service.getSnapshot(), periodNow + 60_000).standardUsdReason, null);
  } finally { await service.close(); }
});
