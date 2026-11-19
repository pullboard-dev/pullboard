/** The foreign-prerequisite guard shared by add and edit [XB1,#11040]. */
import { requireLinkedForeign } from '../../../../../packages/items/index.js';

/**
 * Refuse FOREIGN_UNLINKED when a new or changed --after names a repository this board has no live link to.
 * Why here: add and edit both need it, and it must run before anything is filed or changed; no --after, or one with only local ids, passes.
 *
 * @param {object} board - The open board.
 * @param {string[]|undefined} after - The dependency values being filed or set.
 */
export function requireLinkedAfter(board, after) {
  if (after?.length) requireLinkedForeign(board, after);
}
