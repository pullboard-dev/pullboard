/** A coordinator session's usage is its own ordered move, floored at its engine and attributed to the authenticated seat [C7,H16]. */
import { COORDINATOR_USAGE_ENGINE } from "../../../../state/light.js";

function minimumEngine() { return COORDINATOR_USAGE_ENGINE; }
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordCoordinatorUsage", engine: COORDINATOR_USAGE_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({}) });
