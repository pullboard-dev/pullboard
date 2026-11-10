import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by finishSentinelRun, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  return BOARD_SENTINEL_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "finishSentinelRun", order: 52, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "STALE_SENTINEL": "read pullboard sentinels and ask the person to approve the current exact proposal"
}) });
