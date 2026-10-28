/** Ordinary item holds share their existing transaction and event semantics [B4,C7]. */
import { Refused } from './refused.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { RIGOR_AUTO_ENGINE } from './rigor-auto-engine.js';

/** Hold an open or already claimed item under the existing coordinator authority. */
export function applyItemHold(board, id, { agentId, reason, until }, dependencies) {
  const { coordinatorOnly, atomic, getItem, setItem, now, logEvent, postRigorNotices, itemHold, holdUntilKind, forgetHoldMaintenance, rememberHoldCondition, staleStateEngine } = dependencies;
  coordinatorOnly(agentId, 'holds an item');
  const condition = holdUntilKind(until);
  if (until !== undefined && (board.executionEngineVersion ?? ENGINE_VERSION) < staleStateEngine) {
    throw new Refused('ENGINE_VERSION', 'conditional holds require replay-aware writers; upgrade every linked device');
  }
  const text = String(reason ?? '').trim();
  if (!text) throw new Refused('USAGE', `a hold needs a reason: pullboard hold ${id} "why"`);
  return atomic(board, () => {
    const item = getItem(board, id);
    if (!['open', 'claimed'].includes(item.item_status)) {
      throw new Refused('ITEM_NOT_OPEN', `item #${id} is ${item.item_status}; only open or claimed items can be held`);
    }
    const at = now(board);
    setItem(board, id, { item_hold_reason: text, item_hold_by: agentId, item_hold_at: at });
    forgetHoldMaintenance(board, id);
    logEvent(board, agentId, 'hold_item', id, { reason: text, ...(condition === null ? {} : { until: condition }) });
    if (condition !== null) rememberHoldCondition(board, id, { kind: condition, heldAt: at, holdEventId: board.lastEvent.event_id });
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= RIGOR_AUTO_ENGINE) postRigorNotices(board, board.lastEvent);
    return itemHold(board, id);
  });
}

/** Lift a coordinator item hold while preserving every other lifecycle field. */
export function applyItemHoldRelease(board, id, { agentId }, dependencies) {
  const { coordinatorOnly, atomic, itemHold, setItem, logEvent, forgetHoldMaintenance } = dependencies;
  coordinatorOnly(agentId, 'lifts an item hold');
  return atomic(board, () => {
    const held = itemHold(board, id);
    if (!held) throw new Refused('NOT_HELD', `item #${id} is not held`);
    setItem(board, id, { item_hold_reason: null, item_hold_by: null, item_hold_at: null });
    forgetHoldMaintenance(board, id);
    logEvent(board, agentId, 'unhold_item', id, { reason: held.item_hold_reason });
  });
}
