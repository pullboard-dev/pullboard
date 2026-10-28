import { MAIN_AUDIT_ENGINE } from '../main-audit-engine.js';
import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by recordGateRun, discovered without a shared registry edit [C7,V4,H16]. */
import { GATE_RUN_ENGINE } from '../gate-run-engine.js';
import { LANDING_ENVIRONMENT_ENGINE } from '../landing-environment-engine.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';
import { RUN_TIMING_ENGINE } from '../run-timing-engine.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (Object.hasOwn(args[0]?.receipt ?? {}, 'environment')) return LANDING_ENVIRONMENT_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return GATE_RUN_ENGINE;
}

/** New collection evidence may not be silently dropped while historical first-match floors remain intact. */
function minimumEngine(args, board, at) {
  return Math.max(Object.hasOwn(args[0]?.receipt ?? {}, 'collection') ? MAIN_AUDIT_ENGINE : 1,
    Object.hasOwn(args[0]?.receipt ?? {}, 'timing') || Object.hasOwn(args[0]?.receipt ?? {}, 'full') ? RUN_TIMING_ENGINE : 1,
    existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordGateRun", order: 55, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "GATE_RUN_CHANGED": "keep the original gate run unchanged; record a new run with a new id instead of replacing historical evidence",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)"
}) });
