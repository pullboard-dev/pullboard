import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by declareJob, discovered without a shared registry edit [C7,V4,H16]. */
import { RECURRING_JOB_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return RECURRING_JOB_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "declareJob", order: 56, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "BAD_JOB": "name the job and a cadence like 10m, 2h or daily: pullboard loop declare <name> --every 10m --owner <seat or lane>",
  "JOB_CADENCE_COORDINATOR_ONLY": "ask the coordinator to change the cadence: pullboard shout coordinator --kind question \"<job> needs cadence <every>\" --decision"
}) });
