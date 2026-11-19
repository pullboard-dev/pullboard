/** Routing owned by addBlock; an older engine has no block record and refuses it [C7,H16]. */
import { BLOCK_ENGINE } from "../../../../state/light.js";
/** The block payload has no historical interpretation. */
function minimumEngine() { return BLOCK_ENGINE; }
/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: "addBlock", order: 10013, engine: BLOCK_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    "BLOCK_EXISTS": "name the block differently: pullboard block add <another name> <id> <id> --tier <light|mid|strong>",
    "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
    "USAGE": "run pullboard help"
  }) });
