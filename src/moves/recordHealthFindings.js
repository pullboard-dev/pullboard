import { hasPendingDispatchNotices } from '../health-receipts.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../automatic-dispatch-engine.js';
import { CPU_SENTINEL_ENGINE } from '../cpu-sentinel-engine.js';
import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by recordHealthFindings, discovered without a shared registry edit [C7,V4,H16]. */
import { HEALTH_SENTINEL_ENGINE } from '../health-receipts.js';
import { hasPendingCpuNotices } from '../health-receipts.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (args[0]?.dispatch !== undefined || hasPendingDispatchNotices(board)) return AUTOMATIC_DISPATCH_ENGINE;
  if (hasPendingCpuNotices(board)) return CPU_SENTINEL_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (Array.isArray(args[0]?.findings) && args[0].findings.some(finding => finding?.cause === 'AGENT_CPU')) return CPU_SENTINEL_ENGINE;
  return HEALTH_SENTINEL_ENGINE;
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
