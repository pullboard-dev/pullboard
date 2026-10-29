import { applyItemPatchRemoval } from './item-patches.js';
import { getItem } from './board-query.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { invalidateItemPatch } from './board-attach-item-patch.js';

/** Stop applying native bytes without discarding their historical author exclusions. */
export function removeItemPatch(board, id, options) {
  return applyItemPatchRemoval(board, id, options, { atomic, logEvent, getItem, invalidate: changed => invalidateItemPatch(board, changed, options.agentId) });
}
