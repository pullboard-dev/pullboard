/** Batched numeric summaries retain one authenticated actor and their own replay floor [N2,H16]. */
import { USAGE_BATCH_ENGINE } from "../../../../state/light.js";

function minimumEngine() { return USAGE_BATCH_ENGINE; }
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordUsageBatch", engine: USAGE_BATCH_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({}) });
