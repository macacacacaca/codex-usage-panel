export type Counters = {
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
  outputTokens: number; reasoningOutputTokens: number; totalTokens: number;
};
export type TokenSegment = Counters & { model: string | null; longContext: boolean | null };
export type ChatTokens = Counters & {
  segments: TokenSegment[]; updatedAtMs: number | null; complete: boolean;
};
export type AccountTokens = ChatTokens & { sessionCount: number };
export type TokenWindow = { startAtMs: number; endAtMs: number; windowMinutes: number };
export type WindowTokens = AccountTokens & { window: TokenWindow };
export type TokenProfile = {
  trackingId: string | null; chat: ChatTokens | null; chatErrorCode: string | null;
  account: AccountTokens | null; accountErrorCode: string | null;
  period: WindowTokens | null; periodErrorCode: string | null;
  lifetimeTokens: number | null; dailyBuckets: Array<{ date: string; tokens: number }>;
  fetchedAtMs: number | null; errorCode: string | null;
};
export function emptyTokens(trackingId: string | null = null): TokenProfile {
  return { trackingId, chat: null, chatErrorCode: null, account: null, accountErrorCode: null, period: null, periodErrorCode: null, lifetimeTokens: null, dailyBuckets: [], fetchedAtMs: null, errorCode: null };
}
export function counter(value: unknown): number | null {
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function normalizeCounters(raw: any): Counters | null {
  if (!raw || typeof raw !== 'object') return null;
  const inputTokens = counter(raw.input_tokens), outputTokens = counter(raw.output_tokens), totalTokens = counter(raw.total_tokens);
  const cachedInputTokens = counter(raw.cached_input_tokens);
  // Older logs may not report cache writes. Zero is allowed for token display,
  // but the caller must mark the price calculation incomplete in that case.
  const cacheWriteInputTokens = raw.cache_write_input_tokens === undefined ? 0 : counter(raw.cache_write_input_tokens);
  const reasoningOutputTokens = raw.reasoning_output_tokens === undefined ? 0 : counter(raw.reasoning_output_tokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null || cachedInputTokens === null || cacheWriteInputTokens === null || reasoningOutputTokens === null ||
      cachedInputTokens + cacheWriteInputTokens > inputTokens || reasoningOutputTokens > outputTokens ||
      inputTokens + outputTokens !== totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens };
}
export function normalizeAccountTokens(raw: any, now: number): Pick<TokenProfile, 'lifetimeTokens' | 'dailyBuckets' | 'fetchedAtMs' | 'errorCode'> {
  const byDate = new Map<string, number>();
  for (const entry of Array.isArray(raw?.dailyUsageBuckets) ? raw.dailyUsageBuckets : []) {
    const tokens = counter(entry?.tokens), date = entry?.startDate;
    if (tokens === null || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) continue;
    // The backend can repeat a date. Do not add duplicate buckets together.
    byDate.set(date, tokens);
  }
  return { lifetimeTokens: counter(raw?.summary?.lifetimeTokens), dailyBuckets: [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, tokens]) => ({ date, tokens })), fetchedAtMs: now, errorCode: null };
}

export const PRICE_CHECKED_DATE = '2026-10-12';
export const PRICE_SOURCE = 'https://developers.openai.com/api/docs/pricing';
// USD per million model tokens; Standard rates. Source checked 2026-10-12.
// More than 272K input tokens in one request: 2x input/cache, 1.5x output.
export const PRICES: Record<string, { input: number; cached: number; write: number; output: number }> = {
  'gpt-6.1-sol': { input: 2, cached: .1, write: 2.5, output: 10 },
  'gpt-6-astra': { input: 10, cached: 1, write: 12.5, output: 50 },
  'gpt-6-luna': { input: .1, cached: .01, write: .125, output: .5 },
};
export function estimateUsd(chat: ChatTokens | null, mode: 'standard' | 'fast' = 'standard'): number | null {
  if (!chat || !chat.complete) return null;
  let total = 0, coveredTokens = 0;
  for (const segment of chat.segments) {
    const prices = segment.model ? PRICES[segment.model] : null;
    if (!prices || segment.longContext === null) return null;
    const baseInput = segment.inputTokens - segment.cachedInputTokens - segment.cacheWriteInputTokens;
    if (baseInput < 0) return null;
    const inputMultiplier = segment.longContext ? 2 : 1, outputMultiplier = segment.longContext ? 1.5 : 1;
    total += (baseInput * prices.input + segment.cachedInputTokens * prices.cached + segment.cacheWriteInputTokens * prices.write) * inputMultiplier / 1_000_000;
    // Reasoning output is already included in outputTokens.
    total += segment.outputTokens * prices.output * outputMultiplier / 1_000_000;
    coveredTokens += segment.totalTokens;
  }
  if (coveredTokens !== chat.totalTokens || !Number.isFinite(total)) return null;
  return total * (mode === 'fast' ? 2 : 1);
}
export function tokenText(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}
export function usdText(value: number | null): string {
  if (value === null) return '—';
  if (value > 0 && value < .01) return '< US$0.01';
  return `US$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
