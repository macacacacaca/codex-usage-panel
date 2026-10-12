import { sameTokenWindow, tokenWindow, type Snapshot } from './domain.ts';
import { estimateUsd, PRICE_CHECKED_DATE } from './tokens.ts';

// The native client shares the exact same currency calculation as the web UI.
export function nativePayload(snapshot: Snapshot, now = Date.now()) {
  const period = sameTokenWindow(snapshot.tokens.period?.window ?? null, tokenWindow(snapshot, now)) ? snapshot.tokens.period : null;
  return { snapshot, standardUsd: estimateUsd(period), fastUsd: estimateUsd(period, 'fast'), priceDate: PRICE_CHECKED_DATE };
}
