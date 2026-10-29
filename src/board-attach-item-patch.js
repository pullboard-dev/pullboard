import { invalidateItemPatch as applyItemPatchInvalidation } from './item-patches.js';
import { applyItemPatchAttachment } from './item-patches.js';
import { getItem } from './board-query.js';
import { reviewHolder } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { IN_STATE } from './machine.js';
import { moveItem } from './board.js';
import { onlyCoordinator } from './board.js';

/** Keep companion lifecycle changes on this board's canonical status writer. */
export function invalidateItemPatch(board, id, agentId) {
  return applyItemPatchInvalidation(board, id, agentId, { moveItem, onlyCoordinator, inState: IN_STATE, getItem, reviewHolder });
}

/** Attach native bytes atomically, with lifecycle mutation confined to moveItem. */
export function attachItemPatch(board, id, options) {
  return applyItemPatchAttachment(board, id, options, { atomic, logEvent, getItem, invalidate: changed => invalidateItemPatch(board, changed, options.agentId) });
}
