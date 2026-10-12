import { emptyTokens, type TokenProfile, type TokenWindow } from './tokens.ts';
export type UsageWindow = {
  slot: 'primary' | 'secondary'; label: string; provided: boolean;
  usedPercent: number | null; remainingPercent: number | null;
  durationMins: number | null; resetsAtMs: number | null;
};
export type Bucket = { id: string; label: string; serverLimitState: string | null; windows: UsageWindow[] };
export type Snapshot = {
  status: 'initializing' | 'checking' | 'ready' | 'stale' | 'offline' | 'signed_out' | 'unavailable';
  planLabel: string | null; fetchedAtMs: number | null; buckets: Bucket[];
  resetCreditsAvailable: number | null; updating: boolean; errorCode: string | null;
  demo: boolean; nextAttemptAtMs: number | null;
  tokens: TokenProfile;
};

export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function clamp(value: number): number { return Math.max(0, Math.min(100, value)); }
export function windowLabel(duration: number | null, slot: string): string {
  if (duration === 10080) return '每週額度';
  if (duration === null) return slot === 'primary' ? '短期額度' : '長期額度';
  if (duration % 1440 === 0) return `${duration / 1440} 天額度`;
  if (duration % 60 === 0) return `${duration / 60} 小時額度`;
  return `${duration} 分鐘額度`;
}
export function normalizeWindow(raw: any, slot: 'primary' | 'secondary'): UsageWindow {
  const used = finite(raw?.usedPercent);
  const duration = finite(raw?.windowDurationMins);
  const seconds = finite(raw?.resetsAt);
  const durationMins = duration !== null && duration > 0 ? duration : null;
  const resetsAtMs = seconds !== null && seconds > 0 && seconds * 1000 <= 8.64e15 ? seconds * 1000 : null;
  return {
    slot, label: windowLabel(durationMins, slot), provided: raw != null,
    usedPercent: used === null ? null : clamp(used),
    remainingPercent: used === null ? null : clamp(100 - used),
    durationMins, resetsAtMs,
  };
}
const PLANS: Record<string, string> = { plus: 'Plus', pro: 'Pro', free: 'Free', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
export function planLabel(plan: unknown): string | null {
  return typeof plan === 'string' && plan.length > 0 ? PLANS[plan] ?? plan.slice(0, 60) : null;
}
export function normalizeUsage(raw: any, plan: unknown, now: number, demo = false): Snapshot {
  // A present but empty map is authoritative; null/absent is the legacy fallback.
  const entries: Array<[string, any]> = raw?.rateLimitsByLimitId != null
    ? Object.entries(raw.rateLimitsByLimitId)
    : raw?.rateLimits ? [[raw.rateLimits.limitId ?? 'codex', raw.rateLimits]] : [];
  const buckets = entries.filter(([, bucket]) => bucket && typeof bucket === 'object').map(([id, bucket]) => ({
    id, label: typeof bucket.limitName === 'string' && bucket.limitName.trim() ? bucket.limitName.slice(0, 120) : id === 'codex' ? 'Codex' : id.slice(0, 120),
    serverLimitState: typeof bucket.rateLimitReachedType === 'string' ? bucket.rateLimitReachedType
      : bucket.spendControlReached === true ? 'spend_control_reached'
      : raw.ordinaryUsageAllowed === false ? 'ordinary_usage_unavailable' : null,
    windows: [normalizeWindow(bucket.primary, 'primary'), normalizeWindow(bucket.secondary, 'secondary')],
  }));
  const count = finite(raw?.rateLimitResetCredits?.availableCount);
  return {
    status: buckets.length ? 'ready' : 'unavailable', planLabel: planLabel(plan ?? entries[0]?.[1]?.planType),
    fetchedAtMs: now, buckets, resetCreditsAvailable: count !== null && count >= 0 ? Math.floor(count) : null,
    updating: false, errorCode: buckets.length ? null : 'no_usage', demo, nextAttemptAtMs: null, tokens: emptyTokens(),
  };
}
/** Use the official Codex 5-hour reset boundary, never a rolling lookback or
 * another metered bucket's percentage. Expired boundaries need a fresh read. */
export function tokenWindow(snapshot: Snapshot, now = Date.now()): TokenWindow | null {
  const bucket = snapshot.buckets.find(bucket => bucket.id === 'codex');
  const window = bucket?.windows.find(window => window.provided && window.durationMins === 300);
  const endAtMs = window?.resetsAtMs;
  if (endAtMs == null || !Number.isFinite(now) || endAtMs <= now) return null;
  const startAtMs = endAtMs - 300 * 60_000;
  if (startAtMs > now || startAtMs < 0) return null;
  return { startAtMs, endAtMs, windowMinutes: 300 };
}
export function sameTokenWindow(a: TokenWindow | null, b: TokenWindow | null): boolean {
  return a === null || b === null ? a === b : a.startAtMs === b.startAtMs && a.endAtMs === b.endAtMs && a.windowMinutes === b.windowMinutes;
}
export function percentText(remaining: number | null): string {
  if (remaining === null) return '—';
  if (remaining > 0 && remaining < 1) return '<1%';
  return `${Math.floor(remaining)}%`;
}
const SERVER_STATES: Record<string, string> = {
  rate_limit_reached: '已達使用上限', workspace_owner_credits_depleted: '工作區額度已用完',
  workspace_member_credits_depleted: '成員額度已用完', workspace_owner_usage_limit_reached: '工作區已達使用上限',
  workspace_member_usage_limit_reached: '成員已達使用上限', spend_control_reached: '已達支出上限',
  ordinary_usage_unavailable: '目前無法使用一般額度',
};
export function quotaState(remaining: number | null, serverState: string | null = null): { label: string; tone: string } {
  if (serverState) return { label: SERVER_STATES[serverState] ?? '伺服器回報使用限制', tone: 'critical' };
  if (remaining === null) return { label: '尚無資料', tone: 'neutral' };
  if (remaining === 0) return { label: '額度已用完', tone: 'critical' };
  if (remaining <= 10) return { label: '接近上限', tone: 'critical' };
  if (remaining <= 30) return { label: '額度偏低', tone: 'warning' };
  return { label: '充足', tone: 'good' };
}
export function countdown(reset: number | null, now = Date.now()): string {
  if (reset === null) return '重置時間未提供';
  const difference = reset - now;
  if (difference <= 0) return '正在確認重置…';
  if (difference < 60_000) return '即將重置';
  const minutes = Math.ceil(difference / 60_000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  if (days) return `${days} 天${hours ? ` ${hours} 小時` : ''}後重置`;
  if (hours) return `${hours} 小時${mins ? ` ${mins} 分` : ''}後重置`;
  return `${mins} 分後重置`;
}
export function absoluteTime(timestamp: number | null, timeZone: string): string {
  if (timestamp === null) return '重置時間未提供';
  const formatted = new Intl.DateTimeFormat('zh-TW', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp);
  return `${formatted} · ${timeZone === 'Asia/Taipei' ? '台北時間' : timeZone === 'UTC' ? 'UTC' : timeZone}`;
}
export function isOld(snapshot: Snapshot, now = Date.now()): boolean {
  return snapshot.fetchedAtMs !== null && (snapshot.status !== 'ready' || now - snapshot.fetchedAtMs > 120_000);
}
export function emptySnapshot(status: Snapshot['status'] = 'initializing', errorCode: string | null = null): Snapshot {
  return { status, errorCode, planLabel: null, fetchedAtMs: null, buckets: [], resetCreditsAvailable: null, updating: false, demo: false, nextAttemptAtMs: null, tokens: emptyTokens() };
}
export function backoffMs(failures: number, random = Math.random): number {
  const base = [15_000, 30_000, 60_000, 120_000, 300_000][Math.min(Math.max(failures - 1, 0), 4)];
  return Math.min(300_000, Math.round(base * (1 + random() * 0.1)));
}
