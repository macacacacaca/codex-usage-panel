import type { Snapshot } from './domain.ts';
import { estimateUsd, PRICE_CHECKED_DATE } from './tokens.ts';

// The native client shares the exact same currency calculation as the web UI.
export function nativePayload(snapshot: Snapshot) {
  return { snapshot, standardUsd: estimateUsd(snapshot.tokens.account), fastUsd: estimateUsd(snapshot.tokens.account, 'fast'), priceDate: PRICE_CHECKED_DATE };
}
