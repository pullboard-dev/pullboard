/** Frozen edit planning, shared without moving the native transaction or lifecycle writer [C7,V4,H16]. */
import { correctedBar } from "../../../../state/light.js";
import { engineAtLeast } from "../../../../state/light.js";
import { COORDINATOR } from "../../../../config/index.js";

/** Plan pending corrections from the exact before/after fields; the caller applies all writes atomically. */
export function itemEditBar(board, item, next, { command, agentId, correction, freeze, unfreeze, expiredHolder, sha256, preserveFrozen = false }) {
  const pendingFields = [
    ...(next.item_criterion !== item.item_criterion ? ['criterion'] : []),
    ...(command !== undefined && next.item_check !== item.item_check ? ['check'] : []),
    ...(next.item_after !== item.item_after ? ['after'] : []),
    ...(next.item_check_timing !== item.item_check_timing ? ['checkTiming'] : []),
    ...(next.item_spec_ids !== item.item_spec_ids ? ['specs'] : []),
  ];
  const frozen = preserveFrozen ? null : correctedBar(board, item, next, { correction, freeze, sha256 });
  const pendingRefreeze = !preserveFrozen && !frozen && engineAtLeast(board, 8)
    && item.item_status === 'claimed' && agentId === COORDINATOR && pendingFields.length > 0;
  const clearFrozen = !preserveFrozen && !frozen && ((unfreeze && !pendingRefreeze) || Boolean(expiredHolder));
  return { pendingFields, frozen, pendingRefreeze, clearFrozen };
}
