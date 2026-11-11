import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by takeCoordinator, discovered without a shared registry edit [C7,V4,H16]. */
import { COORDINATOR_HOLD_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { COMPUTER_NAME_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (args[0]?.name !== undefined) return COMPUTER_NAME_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return COORDINATOR_HOLD_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "takeCoordinator", order: 58, engine: COORDINATOR_HOLD_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator --kind question \"<what you need>\"",
  "COORDINATOR_TAKEOVER": "link the board with pullboard relay on in the main checkout, then run pullboard takeover there"
}) });
