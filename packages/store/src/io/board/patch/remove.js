import { applyItemPatchRemoval } from "../../../../../items/index.js";
import { getItem } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { invalidateItemPatch } from "./attach.js";

/** Stop applying native bytes without discarding their historical author exclusions. */
export function removeItemPatch(board, id, options) {
  return applyItemPatchRemoval(board, id, options, { atomic, logEvent, getItem, invalidate: changed => invalidateItemPatch(board, changed, options.agentId) });
}
