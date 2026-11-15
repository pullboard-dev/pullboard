/** Sanitized usage retains its own replay boundary and authenticated actor [N2,H16]. */
import { COST_ENGINE } from "../../../../state/light.js";
import { COST_INPUT_SPLIT_ENGINE } from "../../../../state/light.js";
import { hasInputSplit } from "../../../../stats/browser.js";

/** Legacy usage retains its original floor; additive provider splits require their own engine. */
function minimumEngine(args) { return hasInputSplit(args[0]?.records) ? COST_INPUT_SPLIT_ENGINE : COST_ENGINE; }

/** Only the named seat may publish its sanitized summary. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordSharedUsage", engine: COST_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({}) });
