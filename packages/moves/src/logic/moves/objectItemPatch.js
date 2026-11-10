import { ITEM_PATCH_AUTO_ENGINE } from "../../../../state/light.js";

/** Objections require the engine that understands the automatic companion lifecycle. */
function minimumEngine() { return ITEM_PATCH_AUTO_ENGINE; }

/** The actor is the registered owner in the lane named by the exact auto-attached patch. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: 'objectItemPatch', engine: ITEM_PATCH_AUTO_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor, nextSteps: Object.freeze({
    ITEM_PATCH_WINDOW: 'only the companion lane owner may object before its recorded deadline',
    NOTE_REQUIRED: 'add --note "<what happened>"',
  }) });
