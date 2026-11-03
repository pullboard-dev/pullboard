import { milestones } from './board-milestones-read.js';

/** A claim on a pinned item that shows no real work for this long lapses to open [C7]. */
export const PINNED_CLAIM_RELEASE_MS = 30 * 60_000;

/**
 * Whether the coordinator has pinned this item: it is ranked in a milestone with a recorded pin reason and is not sunk.
 * Held beside the milestone reader so the capture and the apply step judge the same board state.
 *
 * @param {any} board
 * @param {number} id
 * @returns {boolean}
 */
export function itemPinned(board, id) {
  return milestones(board).some(entry => (entry.order ?? []).includes(id) && (entry.items ?? []).includes(id)
    && !(entry.sunk ?? []).includes(id) && Object.hasOwn(entry.reasons ?? {}, String(id)));
}
