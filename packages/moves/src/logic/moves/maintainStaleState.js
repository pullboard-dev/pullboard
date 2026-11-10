import { STRANDED_DEPENDENCY_ENGINE } from '../../../../state/light.js';
/** Coordinator maintenance is a versioned native operation, never a direct housekeeping write [B4,C7]. */
import { LEASE_LAPSE_ENGINE } from "../../../../state/light.js";
import { STALE_STATE_ENGINE } from "../../../../state/light.js";
import { CLAIM_IDLE_ENGINE } from "../../../../state/light.js";

/** An older engine cannot interpret captured inactivity as permission to release another holder. */
function minimumEngine(args) {
  if (args[0]?.snapshot?.limits?.dependency !== undefined) return STRANDED_DEPENDENCY_ENGINE;
  if (args[0]?.snapshot?.claims?.some?.(row => row?.idle !== undefined)) return CLAIM_IDLE_ENGINE;
  return args[0]?.claimsOnly === true ? LEASE_LAPSE_ENGINE : STALE_STATE_ENGINE;
}

/** Bind the same coordinator actor used by the store operation. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'maintainStaleState', order: 1001, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
    COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator --kind question \"<what you need>\"',
    ENGINE_VERSION: 'upgrade Pullboard: npm install -g pullboard@latest',
    STALE_STATE_CHANGED: 'capture the current hold and reservation state again before releasing anything',
    BAD_STALE_STATE: 'capture a complete current stale-state observation with pullboard sentinel run',
  }),
});
