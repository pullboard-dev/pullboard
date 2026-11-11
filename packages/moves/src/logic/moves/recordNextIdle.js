/** Empty-next observations use the existing authenticated ordered protocol [R2,N2]. */
import { NEXT_IDLE_ENGINE } from "../../../../state/light.js";
import { FOCUS_BOUNDARY_ENGINE } from '../../../../state/light.js';
/** Older replicas must not silently omit a prospective observation. */
function minimumEngine(args) { return args[0]?.reason === 'focus' ? FOCUS_BOUNDARY_ENGINE : NEXT_IDLE_ENGINE; }
/** Bind the observation to its authenticated native actor. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: 'recordNextIdle', order: 1000, engine: NEXT_IDLE_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
    BAD_IDLE_REASON: 'run next again and use its structured idle observation',
  }) });
