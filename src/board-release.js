import { releaseClaim } from './release-claim.js';
import { itemById } from './board-query.js';
import { reviewHolder } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { moveItem } from './board.js';
import { setItem } from './board.js';
import { reviewReleaseNoteProblem } from './board-review-release-note.js';
import { insertShout } from './board-shout.js';

/**
 * Hand a claimed item back, or free the caller's live review reservation on a submitted item.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} agentId
 * @param {string} [note] One-line reason required when releasing a submitted review.
 * @param {{seat: string, lastSeen: string}} [goneSeat] Frozen coordinator observation, never a caller identity.
 * @returns {boolean} Whether a review reservation was released rather than a claim.
 */
export function release(board, id, agentId, note = '', goneSeat) {
  return releaseClaim(board, id, agentId, note, goneSeat, { atomic, itemById, reviewHolder,
    reviewReleaseNoteProblem, setItem, moveItem, logEvent, insertShout });
}
