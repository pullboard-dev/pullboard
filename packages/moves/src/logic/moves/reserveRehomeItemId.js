import { PRIVATE_REHOME_ENGINE } from "../../../../state/light.js";

/** Reserve an item ID before the matching source move names it [E15,H16]. */
function minimumEngine() { return PRIVATE_REHOME_ENGINE; }
/** Read the actor from the reservation options [H2,H16]. */
function actor(move) { return move.args[2]?.agentId ?? null; }

export default Object.freeze({ operation: 'reserveRehomeItemId', order: 10000, engine: PRIVATE_REHOME_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
    REHOME_CONFLICT: 'keep the original source move ID and resolve the destination board conflict before retrying',
    REHOME_FORMAT: 'restore the exact source move record and retry it with an authorized destination handle',
  }) });
