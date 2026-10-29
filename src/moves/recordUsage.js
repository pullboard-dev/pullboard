/** Sanitized usage retains its own replay boundary and authenticated actor [N2,H16]. */
import { COST_ENGINE } from '../cost-engine.js';

/** This operation was introduced with native usage accounting. */
function minimumEngine() { return COST_ENGINE; }

/** Only the named seat may publish its sanitized summary. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordUsage", engine: COST_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({}) });
