import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { AdapterError, CodexAdapter } from './adapter.ts';
import { backoffMs, emptySnapshot, normalizeUsage, sameTokenWindow, tokenWindow, type Snapshot } from './domain.ts';
import { AccountTokenReader, LocalTokenReader } from './local-tokens.ts';
import { emptyTokens, normalizeAccountTokens, type ChatTokens } from './tokens.ts';

function authKey(response: any): string | null {
  const account = response?.account;
  // account/read has no stable ID. Use the email only in memory to verify quota
  // reads; local session ownership additionally requires an explicit accountId.
  return account?.type === 'chatgpt' && typeof account.email === 'string' && account.email.trim()
    ? createHash('sha256').update(account.email.trim().toLowerCase()).digest('hex') : null;
}
type Panel = { visible: boolean; hiddenAt: number | null; interval: number };

export class UsageService extends EventEmitter {
  adapter: CodexAdapter;
  snapshot = emptySnapshot();
  inFlight: Promise<Snapshot> | null = null;
  identity: string | null = null;
  accountKey: string | null = null;
  generation = 0;
  failures = 0;
  closed = false;
  panels = new Map<string, Panel>();
  timer: ReturnType<typeof setTimeout> | null = null;
  tickTimer: ReturnType<typeof setInterval> | null = null;
  notificationTimer: ReturnType<typeof setTimeout> | null = null;
  resetChecks = new Set<number>();
  demo: boolean;
  now: () => number;
  random: () => number;
  started = false;
  lastTick = 0;
  trackingId: string | null;
  sourceAccountId: string | null = null;
  tokenGeneration = 0;
  localReader: Pick<LocalTokenReader, 'read'>;
  accountReader: Pick<AccountTokenReader, 'read'>;
  localInFlight: Promise<void> | null = null;
  localReadGeneration: number | null = null;

  constructor({ adapter = new CodexAdapter(), demo = false, now = Date.now, random = Math.random,
    trackingId = null as string | null, localReader = new LocalTokenReader() as Pick<LocalTokenReader, 'read'>,
    accountReader = new AccountTokenReader() as Pick<AccountTokenReader, 'read'> } = {}) {
    super(); this.adapter = adapter; this.demo = demo; this.now = now; this.random = random;
    this.trackingId = trackingId; this.localReader = localReader; this.accountReader = accountReader;
    this.snapshot.tokens = emptyTokens(trackingId);
    adapter.on('account/updated', () => {
      this.invalidate();
      if (!this.inFlight && !this.closed) void this.refresh();
    });
    adapter.on('account/rateLimits/updated', () => {
      // Installed schema explicitly calls this a sparse update: always refetch.
      if (this.inFlight || this.notificationTimer || this.closed) return;
      this.notificationTimer = setTimeout(() => {
        this.notificationTimer = null; void this.refresh();
      }, 300);
    });
    adapter.on('disconnected', (code: string) => {
      this.failures++;
      this.invalidate('offline', code);
      if (this.started && !this.inFlight) this.schedule(backoffMs(this.failures, this.random));
    });
  }

  publish(): void { this.emit('snapshot', this.getSnapshot()); }
  getSnapshot(): Snapshot {
    // Readers and consumers must not share mutable counters or segment arrays.
    const s = structuredClone(this.snapshot);
    if (s.status === 'ready' && s.fetchedAtMs !== null && this.now() - s.fetchedAtMs > 120_000) s.status = 'stale';
    const window = tokenWindow(s, this.now());
    if (!window || s.tokens.period && !sameTokenWindow(s.tokens.period.window, window)) {
      const expired = s.tokens.period?.window.endAtMs != null && s.tokens.period.window.endAtMs <= this.now();
      s.tokens.period = null;
      s.tokens.periodErrorCode = expired ? 'window_expired' : 'window_unavailable';
    }
    return s;
  }
  invalidate(status: Snapshot['status'] = 'checking', code: string | null = null): void {
    this.generation++; this.clearSnapshot(status, code); this.publish();
  }
  clearSnapshot(status: Snapshot['status'], code: string | null = null): void {
    this.identity = null; this.accountKey = null; this.sourceAccountId = null; this.tokenGeneration++;
    this.resetChecks.clear(); this.snapshot = emptySnapshot(status, code);
    this.snapshot.tokens = emptyTokens(this.trackingId);
  }
  async setTrackingId(id: string | null): Promise<void> {
    if (id === this.trackingId) return;
    this.trackingId = id; this.tokenGeneration++;
    this.snapshot.tokens = { ...this.snapshot.tokens, trackingId: id, chat: null, chatErrorCode: null };
    this.publish();
    if (this.localInFlight) await this.localInFlight;
    await this.refreshLocalTokens();
  }
  refreshLocalTokens(): Promise<void> {
    if (this.closed || this.demo || !this.sourceAccountId) return Promise.resolve();
    if (this.localInFlight) {
      if (this.localReadGeneration === this.tokenGeneration) return this.localInFlight;
      // Serialize readers, but let callers await the new identity's result too.
      return this.localInFlight.then(() => this.refreshLocalTokens());
    }
    const accountId = this.sourceAccountId, id = this.trackingId, generation = this.tokenGeneration;
    const now = this.now(), window = tokenWindow(this.snapshot, now);
    this.localReadGeneration = generation;
    this.localInFlight = (async () => {
      const [chatResult, accountResult] = await Promise.all([
        id === null ? Promise.resolve({ chat: null, errorCode: 'no_tracked_thread' })
          : Promise.resolve().then(() => this.localReader.read(id, accountId)).catch(() => ({ chat: null, errorCode: 'log_unavailable' })),
        Promise.resolve().then(() => this.accountReader.read(accountId, window, now)).catch(() => ({ account: null, errorCode: 'log_unavailable', period: null, periodErrorCode: 'log_unavailable' })),
      ]);
      if (this.closed || generation !== this.tokenGeneration || accountId !== this.sourceAccountId || id !== this.trackingId) return;
      const period = sameTokenWindow(window, tokenWindow(this.snapshot, this.now())) && window &&
        sameTokenWindow(accountResult.period?.window ?? null, window) ? accountResult.period : null;
      this.snapshot.tokens = { ...this.snapshot.tokens, trackingId: id,
        chat: structuredClone(chatResult.chat), chatErrorCode: chatResult.errorCode,
        account: structuredClone(accountResult.account), accountErrorCode: accountResult.errorCode,
        period: structuredClone(period),
        periodErrorCode: window === null ? 'window_unavailable' : window.endAtMs <= this.now() ? 'window_expired'
          : accountResult.periodErrorCode ?? (period ? null : 'window_unavailable') };
      this.publish();
    })().finally(() => {
      this.localInFlight = null; this.localReadGeneration = null;
      if (!this.closed && generation !== this.tokenGeneration && this.sourceAccountId) void this.refreshLocalTokens();
    });
    return this.localInFlight;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true; this.lastTick = this.now(); void this.refresh();
    this.tickTimer = setInterval(() => this.tick(), 10_000);
  }

  tick(): void {
    if (this.closed) return;
    const now = this.now();
    const woke = now - this.lastTick > 60_000; this.lastTick = now;
    this.publish();
    if (woke) { void this.refresh(); return; }
    const expired = this.snapshot.buckets.flatMap(b => b.windows).map(w => w.resetsAtMs)
      .filter((time): time is number => time !== null && time <= now && !this.resetChecks.has(time));
    if (expired.length && !this.inFlight) {
      expired.forEach(time => this.resetChecks.add(time)); void this.refresh();
    }
    if (!this.inFlight) void this.refreshLocalTokens();
  }

  refresh(): Promise<Snapshot> {
    if (this.inFlight) return this.inFlight;
    if (this.closed) return Promise.resolve(this.getSnapshot());
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.snapshot = { ...this.snapshot, updating: true, nextAttemptAtMs: null }; this.publish();
    const generation = this.generation;
    this.inFlight = this.read(generation).finally(() => {
      this.inFlight = null;
      if (this.closed) return;
      if (generation !== this.generation) {
        this.schedule(this.snapshot.status === 'offline' ? backoffMs(this.failures || 1, this.random) : 0); return;
      }
      const delay = this.failures ? backoffMs(this.failures, this.random) : this.pollInterval();
      this.schedule(delay);
    });
    return this.inFlight;
  }

  async read(generation: number): Promise<Snapshot> {
    let verified = false;
    const deadline = Date.now() + 15_000;
    const request = (method: string, params?: object) => this.adapter.request(method, params, Math.max(1, deadline - Date.now()));
    try {
      if (this.demo) {
        await new Promise(resolve => setTimeout(resolve, 180));
        const now = this.now();
        this.snapshot = normalizeUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: (now + 8_040_000) / 1000 }, secondary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: (now + 525_600_000) / 1000 } }, rateLimitResetCredits: { availableCount: 3 } }, 'plus', now, true);
        const chat: ChatTokens = { inputTokens: 900000, cachedInputTokens: 800000, cacheWriteInputTokens: 0, outputTokens: 20000, reasoningOutputTokens: 6000, totalTokens: 920000, segments: [], updatedAtMs: now, complete: true };
        const { segments: _segments, updatedAtMs: _time, complete: _complete, ...counters } = chat;
        chat.segments = [{ ...counters, model: 'gpt-6.1-sol', longContext: false }];
        this.snapshot.tokens = { ...emptyTokens(this.trackingId), chat, account: { ...structuredClone(chat), sessionCount: 3 },
          period: { ...structuredClone(chat), sessionCount: 3, window: tokenWindow(this.snapshot, now)!, excludedReviewTokens: 0 },
          ...normalizeAccountTokens({ summary: { lifetimeTokens: 12640000 }, dailyUsageBuckets: [{ startDate: '2026-10-07', tokens: 740000 }] }, now) };
        this.failures = 0; this.publish(); return this.getSnapshot();
      }
      await this.adapter.start();
      const before = await request('account/read', { refreshToken: false });
      if (generation !== this.generation) return this.getSnapshot();
      if (!before.account) { this.clearSnapshot('signed_out', 'auth_required'); }
      else if (before.account.type !== 'chatgpt') {
        this.clearSnapshot('unavailable', 'unsupported_auth');
      } else {
        const key = authKey(before);
        if (!key) throw new AdapterError('identity_unknown');
        if (this.accountKey && key !== this.accountKey) {
          this.clearSnapshot('checking'); this.publish();
        }
        this.accountKey = key; verified = true;
        const raw = await request('account/rateLimits/read');
        verified = false;
        // Optional token history must never make subscription quota unavailable.
        let accountTokens = null, tokenError: string | null = null;
        try {
          accountTokens = normalizeAccountTokens(await this.adapter.request('account/usage/read', {}, Math.max(1, Math.min(5_000, deadline - Date.now()))), this.now());
        } catch (error: any) { tokenError = error?.code ?? 'upstream_error'; }
        const after = await request('account/read', { refreshToken: false });
        if (generation !== this.generation) return this.getSnapshot();
        if (authKey(after) !== key) { this.invalidate(); return this.getSnapshot(); }
        verified = true;
        // accountId is optional in App Server responses, including VS Code's
        // bundled CLI. Quota reads are verified above, but local token records
        // cannot be attributed safely without the backend's explicit ID.
        const accountId = typeof raw.accountId === 'string' && raw.accountId.trim() ? raw.accountId : null;
        const identity = createHash('sha256').update(JSON.stringify([key, accountId])).digest('hex');
        if (identity !== this.identity) {
          this.clearSnapshot('checking'); this.publish();
        }
        const previousTokens = this.snapshot.tokens;
        const previousWindow = tokenWindow(this.snapshot, this.now());
        this.identity = identity; this.accountKey = key; this.sourceAccountId = accountId;
        this.snapshot = normalizeUsage(raw, after.account.planType, this.now());
        this.snapshot.tokens = { ...previousTokens, ...(accountTokens ?? { errorCode: tokenError }), trackingId: this.trackingId };
        if (!sameTokenWindow(previousWindow, tokenWindow(this.snapshot, this.now()))) {
          this.tokenGeneration++;
          this.snapshot.tokens.period = null; this.snapshot.tokens.periodErrorCode = 'window_unavailable';
        }
        if (accountId === null) {
          this.snapshot.tokens = { ...this.snapshot.tokens, chat: null, account: null, period: null,
            chatErrorCode: this.trackingId === null ? 'no_tracked_thread' : 'log_identity_mismatch',
            accountErrorCode: 'log_identity_mismatch', periodErrorCode: 'log_identity_mismatch' };
        } else await this.refreshLocalTokens();
        if (generation !== this.generation) return this.getSnapshot();
      }
      this.failures = 0;
    } catch (error: any) {
      if (generation !== this.generation) return this.getSnapshot();
      const code = error?.code ?? 'upstream_error';
      this.failures++;
      if (['auth_required', 'unsupported_auth', 'identity_unknown'].includes(code) || !verified) {
        this.clearSnapshot(code === 'auth_required' ? 'signed_out' : code === 'identity_unknown' ? 'checking' : code === 'unsupported_auth' ? 'unavailable' : 'offline', code);
      } else {
        // Preserve only a snapshot for the verified auth session; fetch time stays unchanged.
        this.snapshot = { ...this.snapshot, status: 'offline', updating: false, errorCode: code };
      }
    }
    this.snapshot.updating = false; this.publish(); return this.getSnapshot();
  }

  pollInterval(): number {
    const active = [...this.panels.values()].filter(p => p.visible || p.hiddenAt !== null && this.now() - p.hiddenAt < 60_000);
    return active.length ? Math.min(...active.map(p => p.interval * 1000)) : 300_000;
  }
  setPanel(id: string, visible: boolean, interval: number): void {
    const old = this.panels.get(id);
    this.panels.set(id, { visible, interval: [30, 60, 120].includes(interval) ? interval : 60,
      hiddenAt: visible ? null : old?.hiddenAt ?? this.now() });
    if (!this.inFlight && !this.failures) this.reschedulePolling();
    if (visible && (!old || !old.visible) && (this.snapshot.fetchedAtMs === null || this.now() - this.snapshot.fetchedAtMs > 5_000)) void this.refresh();
  }
  removePanel(id: string): void { this.panels.delete(id); if (!this.inFlight && !this.failures) this.reschedulePolling(); }
  reschedulePolling(): void {
    const elapsed = this.snapshot.fetchedAtMs === null ? 0 : this.now() - this.snapshot.fetchedAtMs;
    this.schedule(Math.max(0, this.pollInterval() - elapsed));
  }
  schedule(delay: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.snapshot.nextAttemptAtMs = this.now() + delay; this.publish();
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delay);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.panels.clear(); await this.adapter.close();
    if (this.inFlight) await this.inFlight;
    if (this.localInFlight) await this.localInFlight;
  }
}
