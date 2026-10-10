import { CodexAdapter } from '../src/adapter.ts';
const adapter = new CodexAdapter();
try {
  await adapter.start();
  const auth = await adapter.request('account/read', { refreshToken: false });
  console.log(JSON.stringify({ accountType: auth.account?.type ?? 'signed_out', plan: auth.account?.planType ?? null }));
  if (auth.account?.type === 'chatgpt') {
    const data = await adapter.request('account/rateLimits/read');
    const buckets = data.rateLimitsByLimitId ?? { codex: data.rateLimits };
    console.log(JSON.stringify({ identityProvided: Boolean(data.accountId), buckets: Object.entries(buckets).map(([id, bucket]: [string, any]) => ({ id, primary: bucket.primary, secondary: bucket.secondary })), resetCreditsAvailable: data.rateLimitResetCredits?.availableCount ?? null }));
    if (process.argv.includes('--tokens')) {
      for (const params of [{}, ...(process.env.CODEX_THREAD_ID ? [{ threadId: process.env.CODEX_THREAD_ID }] : [])]) {
        try {
          const usage = await adapter.request('account/usage/read', params);
          console.log(JSON.stringify({ scope: 'threadId' in params ? 'thread' : 'account', lifetimeTokens: usage.summary?.lifetimeTokens ?? null,
            latestDay: usage.dailyUsageBuckets?.at(-1) ?? null,
            usdMicros: usage.threadUsage?.estimatedUsageUsdMicros ?? null, groups: usage.threadUsage?.groups ?? null }));
        } catch (error: any) { console.log(JSON.stringify({ tokenRead: 'failed', reason: error.code })); }
      }
    }
  }
} catch (error: any) {
  console.error(JSON.stringify({ status: 'failed', reason: error.code ?? 'unknown' }));
  process.exitCode = 1;
} finally { await adapter.close(); }
