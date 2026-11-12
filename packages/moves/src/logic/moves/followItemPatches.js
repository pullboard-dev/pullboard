/** Only the claimed builder follows unchanged coordinator-authorized companions [C7,H16]. */
import { PATCH_FOLLOW_ENGINE } from "../../../../state/light.js";
/** Never replay applicability-sealed movement under an older engine. */
function minimumEngine() { return PATCH_FOLLOW_ENGINE; }
/** Preserve the authenticated builder as the actor, not any companion author. */
function actor(move) { return move.args[1]?.agentId ?? null; }
export default Object.freeze({ operation: 'followItemPatches', engine: PATCH_FOLLOW_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor, nextSteps: Object.freeze({}) });
