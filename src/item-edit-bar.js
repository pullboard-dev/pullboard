/** Frozen edit planning, shared without moving the native transaction or lifecycle writer [C7,V4,H16]. */
import { correctedBar } from './corrected-bar.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { COORDINATOR } from './config.js';

/** Plan pending corrections from the exact before/after fields; the caller applies all writes atomically. */
export function itemEditBar(board, item, next, { command, agentId, correction, freeze, unfreeze, expiredHolder }) {
  const pendingFields = [
    ...(next.item_criterion !== item.item_criterion ? ['criterion'] : []),
    ...(command !== undefined && next.item_check !== item.item_check ? ['check'] : []),
    ...(next.item_after !== item.item_after ? ['after'] : []),
    ...(next.item_check_timing !== item.item_check_timing ? ['checkTiming'] : []),
  ];
  const frozen = correctedBar(board, item, next, { correction, freeze });
  const pendingRefreeze = !frozen && (board.executionEngineVersion ?? ENGINE_VERSION) >= 8
    && item.item_status === 'claimed' && agentId === COORDINATOR && pendingFields.length > 0;
  const clearFrozen = !frozen && ((unfreeze && !pendingRefreeze) || Boolean(expiredHolder));
  return { pendingFields, frozen, pendingRefreeze, clearFrozen };
}
