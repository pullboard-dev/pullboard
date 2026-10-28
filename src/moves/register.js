import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by register, discovered without a shared registry edit [C7,V4,H16]. */
import { VERIFIER_STANDING_ENGINE } from '../engine-metadata.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.engine >= VERIFIER_STANDING_ENGINE ? (move.args[0]?.createdBy === 'machine' ? null : move.args[0]?.createdBy ?? null) : null; }

export default Object.freeze({ operation: "register", order: 6, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ALREADY_JOINED": "create a worktree for the other lane: pullboard worktree <lane> --model \"<model name>\", then work from the path it prints",
  "BAD_ROUTE": "use --route light, mid or strong",
  "NO_AGENT": "create and join a lane worktree: pullboard worktree <lane> --model \"<model name>\"",
  "ONE_COORDINATOR": "make a lane worktree and join it as an agent: pullboard worktree <lane> --model \"<model name>\""
}) });
