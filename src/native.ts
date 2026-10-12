import { sameTokenWindow, tokenWindow, type Snapshot } from './domain.ts';
import { estimateUsd, PRICE_CHECKED_DATE, PRICES } from './tokens.ts';

// The native client shares the exact same currency calculation as the web UI.
export function nativePayload(snapshot: Snapshot, now = Date.now()) {
  const period = sameTokenWindow(snapshot.tokens.period?.window ?? null, tokenWindow(snapshot, now)) ? snapshot.tokens.period : null;
  const standardUsd = estimateUsd(period);
  const standardUsdReason = standardUsd === null && period?.complete &&
    period.segments.some(segment => !segment.model || !Object.hasOwn(PRICES, segment.model)) ? 'unknown_model' : null;
  return { snapshot, standardUsd, fastUsd: estimateUsd(period, 'fast'), standardUsdReason, priceDate: PRICE_CHECKED_DATE };
}
