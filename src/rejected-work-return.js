/** Preserve native seat observation at the sentinel provider boundary [B13,H16]. */
import { withSeatPresence } from './seat-presence.js';
import { rejectedWorkReturns as deriveRejectedWorkReturns } from '../packages/state/index.js';

/** Derive episodes using this native board connection and its ordinary presence reader. */
export function rejectedWorkReturns(board, findings) {
  return deriveRejectedWorkReturns(board, findings, withSeatPresence);
}
