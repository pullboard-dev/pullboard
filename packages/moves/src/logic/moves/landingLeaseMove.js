import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by landingLeaseMove, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { LANDING_LOCAL_LEASE_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.localHeartbeat === true) return LANDING_LOCAL_LEASE_ENGINE;
  return LANDING_LEASE_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "landingLeaseMove", order: 59, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator --kind question \"<what you need>\"",
  "LAND_LEASE_REQUEST": "start a new pullboard land command from the coordinator main checkout"
}) });
