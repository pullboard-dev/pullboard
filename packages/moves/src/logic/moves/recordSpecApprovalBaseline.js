import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by recordSpecApprovalBaseline, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { SPEC_APPROVAL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return SPEC_APPROVAL_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordSpecApprovalBaseline", order: 41, engine: SPEC_APPROVAL_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator --kind question \"<what you need>\"",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)",
  "SPEC_APPROVAL_BASELINE": "ask the coordinator to restore the original approval baseline from a known-good board export"
}) });
