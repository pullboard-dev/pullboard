/** Frozen edit planning, shared without moving the native transaction or lifecycle writer [C7,V4,H16]. */
import { correctedBar } from "../../../state/core.js";
import { engineAtLeast } from "../../../state/core.js";
import { COORDINATOR } from "../../../config/index.js";

/** Plan pending corrections from the exact before/after fields; the caller applies all writes atomically. */
export function itemEditBar(board, item, next, { command, agentId, correction, freeze, unfreeze, expiredHolder, sha256 }) {
  const pendingFields = [
    ...(next.item_criterion !== item.item_criterion ? ['criterion'] : []),
    ...(command !== undefined && next.item_check !== item.item_check ? ['check'] : []),
    ...(next.item_after !== item.item_after ? ['after'] : []),
    ...(next.item_check_timing !== item.item_check_timing ? ['checkTiming'] : []),
  ];
  const frozen = correctedBar(board, item, next, { correction, freeze, sha256 });
  const pendingRefreeze = !frozen && engineAtLeast(board, 8)
    && item.item_status === 'claimed' && agentId === COORDINATOR && pendingFields.length > 0;
  const clearFrozen = !frozen && ((unfreeze && !pendingRefreeze) || Boolean(expiredHolder));
  return { pendingFields, frozen, pendingRefreeze, clearFrozen };
}
