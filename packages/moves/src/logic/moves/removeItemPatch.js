import { ITEM_PATCH_SUBMIT_ENGINE } from "../../../../state/light.js";
import { PATCH_FOLLOW_ENGINE } from "../../../../state/light.js";
import { itemPatchRecords } from "../../../../items/browser.js";
/** Native coordinator patch inputs preserve source and author authority [V4,H16]. */
import { ITEM_PATCH_ENGINE } from "../../../../state/light.js";
/** Old engines must never interpret new patch payloads. */
function minimumEngine(args, board) {
  if (board && itemPatchRecords(board, args[0]).some(record => record.attachedCommit)) return PATCH_FOLLOW_ENGINE;
  return args[1]?.presubmit === true ? ITEM_PATCH_SUBMIT_ENGINE : ITEM_PATCH_ENGINE;
}
/** The actor is the explicit coordinator argument, not the patch author. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default Object.freeze({ operation: 'removeItemPatch', engine: ITEM_PATCH_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor, nextSteps: Object.freeze({
    ITEM_PATCH_KEY: 'choose a stable immutable patch key',
    ITEM_PATCH_STATE: 'attach only to claimed or unmerged submitted or verified work',
    ITEM_PATCH_SOURCE: 'bind patches to the exact submitted commit and compose them before review',
    ITEM_PATCH_AUTHOR: 'name an existing native author seat',
    ITEM_PATCH_FORMAT: 'supply bounded UTF8 git unified or binary patch bytes',
    ITEM_PATCH_CONFLICT: 'keep the original key immutable; use another key for different input',
    ITEM_PATCH_CHANGED: 'read and compose the current patch set before reviewing',
    NO_ITEM_PATCH: 'list the current item patches and select an existing key'
  }) });
