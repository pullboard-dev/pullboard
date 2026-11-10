import { milestones } from './board/milestones.js';

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

/**
 * Whether the item's work jumps routine queues: the coordinator marked it urgent or pinned it in its milestone.
 * Why: an unblocking fix (#3001) waited 20 minutes behind about 50 routine resubmits in the gate queue (#3062).
 *
 * @param {any} board
 * @param {number} id
 * @returns {boolean}
 */
export function itemUrgent(board, id) {
  const flag = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_urgent:${id}`);
  return flag?.meta_value === 'on' || itemPinned(board, id);
}
