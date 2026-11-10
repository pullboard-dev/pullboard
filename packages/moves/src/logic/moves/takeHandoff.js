/** Routing metadata for accepted handoff moves [B3,N19,H16,C7]. */
import { HANDOFF_ENGINE } from "../../../../state/light.js";
/** Accepted handoff operations require their feature engine before all older conditions. */
function minimumEngine() { return HANDOFF_ENGINE; }
/** Both accepted handoff operations name their actor in their first options argument. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: "takeHandoff", order: 1, engine: HANDOFF_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({}) });
