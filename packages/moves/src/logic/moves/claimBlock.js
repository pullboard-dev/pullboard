/** Routing owned by claimBlock; an older engine has no block to claim and refuses it [C7,H16]. */
import { BLOCK_ENGINE } from "../../../../state/light.js";
/** The block claim payload has no historical interpretation. */
function minimumEngine() { return BLOCK_ENGINE; }
/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: "claimBlock", order: 10013, engine: BLOCK_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    "BLOCK_CLAIMED": "another seat holds this block; see pullboard block list or take another block",
    "BLOCK_TIER": "this block needs a seat of another tier; see pullboard block list or ask another seat",
    "NO_BLOCK": "no block has that name; see pullboard block list"
  }) });
