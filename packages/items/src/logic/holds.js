/** Ordinary item holds share their existing transaction and event semantics [B4,C7]. */
import { Refused } from "../../../kernel/index.js";
import { ENGINE_VERSION } from "../../../state/index.js";
import { RIGOR_AUTO_ENGINE } from "../../../state/index.js";
import { VERIFIED_ITEM_HOLD_ENGINE } from "../../../state/light.js";

/** Hold an open or already claimed item under the existing coordinator authority. */
export function applyItemHold(board, id, { agentId, reason, until, owner, deadline, requireOwner }, dependencies) {
  const { rememberHoldOwner, coordinatorOnly, atomic, getItem, setItem, now, logEvent, postRigorNotices, itemHold, holdUntilKind, forgetHoldMaintenance, rememberHoldCondition, staleStateEngine } = dependencies;
  coordinatorOnly(agentId, 'holds an item');
  const condition = holdUntilKind(until);
  if (until !== undefined && (board.executionEngineVersion ?? ENGINE_VERSION) < staleStateEngine) {
    throw new Refused('ENGINE_VERSION', 'conditional holds require replay-aware writers; upgrade every linked device');
  }
  const text = String(reason ?? '').trim();
  if (!text) throw new Refused('USAGE', `a hold needs a reason: pullboard hold ${id} "why"`);
  const named = String(owner ?? '').trim();
  if (requireOwner === true && !named) throw new Refused('HOLD_OWNER_REQUIRED', `a hold needs an owner while holds.requireOwner is on: pullboard hold ${id} "why" --owner <seat, lane or person>`);
  if ((named || deadline !== undefined) && (board.executionEngineVersion ?? ENGINE_VERSION) < staleStateEngine) {
    throw new Refused('ENGINE_VERSION', 'a hold owner and deadline require replay-aware writers; upgrade every linked device');
  }
  if (deadline !== undefined && !Number.isFinite(Date.parse(deadline))) throw new Refused('USAGE', `a hold deadline is a date and time, such as 2026-11-20T09:00:00Z, not ${JSON.stringify(deadline)}`);
  return atomic(board, () => {
    const item = getItem(board, id);
    // A verified item can be held out of landing batches from this engine on; it keeps its accept [C7].
    const holdable = (board.executionEngineVersion ?? ENGINE_VERSION) >= VERIFIED_ITEM_HOLD_ENGINE ? ['open', 'claimed', 'verified'] : ['open', 'claimed'];
    if (!holdable.includes(item.item_status) || item.item_merged_commit) {
      throw new Refused('ITEM_NOT_OPEN', `item #${id} is ${item.item_status}; only open, claimed or verified items can be held`);
    }
    const at = now(board);
    setItem(board, id, { item_hold_reason: text, item_hold_by: agentId, item_hold_at: at });
    forgetHoldMaintenance(board, id);
    // An owner means the hold lapses: one day out unless the caller names a deadline; the instant is the board's own clock, so replicas agree [C7,#8539].
    const record = named ? { owner: named, deadline: deadline === undefined ? new Date(Date.parse(at) + 86_400_000).toISOString() : new Date(Date.parse(deadline)).toISOString() } : null;
    if (record) rememberHoldOwner(board, id, record);
    logEvent(board, agentId, 'hold_item', id, { reason: text, ...(condition === null ? {} : { until: condition }), ...(requireOwner === true ? { requireOwner: true } : {}), ...(record ?? {}) });
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
