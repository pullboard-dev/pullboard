import { asSubmitted } from "../../../../../verify/index.js";
import { refuseUnreviewable } from "../../../../../verify/index.js";
import { invalidateItemPatch as applyItemPatchInvalidation } from "../../../../../items/index.js";
import { applyItemPatchAttachment } from "../../../../../items/index.js";
import { applyItemPatchObjection } from "../../../../../items/index.js";
import { getItem } from "../query.js";
import { listAgents } from "../query.js";
import { reviewHolder } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { IN_STATE } from "../../../../../state/index.js";
import { moveItem } from "../../board.js";
import { onlyCoordinator } from "../../board.js";
import { persistShout } from "../shout.js";

/** Keep companion lifecycle changes on this board's canonical status writer. */
export function invalidateItemPatch(board, id, agentId) {
  return applyItemPatchInvalidation(board, id, agentId, { moveItem, onlyCoordinator, inState: IN_STATE, getItem, reviewHolder });
}

/** Attach native bytes atomically, with lifecycle mutation confined to moveItem. */
export function attachItemPatch(board, id, options) {
  return applyItemPatchAttachment(board, id, options, { atomic, logEvent, getItem, listAgents, asSubmitted, refuseUnreviewable,
    invalidate: changed => invalidateItemPatch(board, changed, options.agentId),
    notifyOwner: (targetBoard, message) => persistShout(targetBoard, { from: message.builder, to: message.owner,
      text: `#${message.item} has companion patch ${message.key} attached at submit; object during the review window with pullboard patch object ${message.item} ${message.key} --note "reason".` }),
  });
}

/** Reopen submitted work atomically when its owning companion lane objects within the recorded window [C7]. */
export function objectItemPatch(board, id, options) {
  return applyItemPatchObjection(board, id, options, { atomic, getItem, logEvent, moveItem });
}
