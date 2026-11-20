import { validateItemDependencies } from "./item/dependencies.js";
import { releaseClaim } from "../../logic/board/claim.js";
import { itemById } from "./query.js";
import { reviewHolder } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { moveItem } from "../board.js";
import { setItem } from "../board.js";
import { reviewReleaseNoteProblem } from "./review/note.js";
import { insertShout } from "./shout.js";
import { escalate } from "../../logic/board/escalate.js";
import { endReservation } from "./hold/item.js";

/**
 * Hand a claimed item back, or free the caller's live review reservation on a submitted item.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} agentId
 * @param {string} [note] One-line reason required when releasing a submitted review.
 * @param {{seat: string, lastSeen: string}} [goneSeat] Frozen coordinator observation, never a caller identity.
 * @param {string} [reasonCode] Coded maintenance reason supplied alongside a frozen observation.
 * @returns {boolean} Whether a review reservation was released rather than a claim.
 */
export function release(board, id, agentId, note = '', goneSeat, reasonCode) {
  return atomic(board, () => {
    const before = itemById(board, id);
    const reviewed = releaseClaim(board, id, agentId, note, goneSeat, { atomic, itemById, reviewHolder,
      reviewReleaseNoteProblem, setItem, moveItem, logEvent, insertShout, validateItemDependencies, escalate }, reasonCode);
    // route.reservations: a reservation ends when its holder hands the claim back [C7,#9162].
    if (!reviewed && before.item_reservation_holder === agentId) endReservation(board, id, { agentId, why: 'holder released the item' });
    return reviewed;
  });
}
