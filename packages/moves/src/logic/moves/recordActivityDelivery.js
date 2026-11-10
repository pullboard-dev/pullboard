/** Recipient-owned interrupt receipts use the existing authenticated ordered move protocol [H2,H16,N26]. */
import { BOARD_PROGRESS_ENGINE } from '../../../../state/light.js';
import { ACTIVITY_DELIVERY_ENGINE } from "../../../../state/light.js";
/** Never let an older replica silently omit a delivery or acknowledgement. */
function minimumEngine(args) {
  return args[0]?.interrupts?.some?.(entry => ['stalled', 'unblocked'].includes(entry?.reason))
    ? BOARD_PROGRESS_ENGINE : ACTIVITY_DELIVERY_ENGINE;
}
/** Use the actual recipient argument, never a transport-selected alias. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: 'recordActivityDelivery', order: 1000, engine: ACTIVITY_DELIVERY_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
    BAD_ACTIVITY_RECEIPT: 'read your own inbox again and use its exact interrupt ids',
    STALE_ACTIVITY_RECEIPT: 'read inbox again; the claim changed before delivery was recorded',
  }) });
