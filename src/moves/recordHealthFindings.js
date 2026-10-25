import { REJECTED_WORK_RETURN_ENGINE } from '../rejected-work-return-engine.js';
import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by recordHealthFindings, discovered without a shared registry edit [C7,V4,H16]. */
import { HEALTH_SENTINEL_ENGINE } from '../health-receipts.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingMinimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return HEALTH_SENTINEL_ENGINE;
}

/** A queue-return observation cannot run under an engine that ignores its authority or effects. */
function minimumEngine(args, board, at) {
  return Math.max(existingMinimumEngine(args, board, at), args[0]?.returnRejected !== undefined && args[0].returnRejected !== false ? REJECTED_WORK_RETURN_ENGINE : 1);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordHealthFindings", order: 48, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "HEALTH_SCAN_STALE": "run pullboard sentinel run again to scan the current board before posting sentinel notices",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)"
}) });
