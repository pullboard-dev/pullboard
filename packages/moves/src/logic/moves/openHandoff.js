/** Routing metadata for accepted handoff moves [B3,N19,H16,C7]. */
import { HANDOFF_ENGINE } from "../../../../state/light.js";
/** Accepted handoff operations require their feature engine before all older conditions. */
function minimumEngine() { return HANDOFF_ENGINE; }
/** Both accepted handoff operations name their actor in their first options argument. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: "openHandoff", order: 0, engine: HANDOFF_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor, nextSteps: Object.freeze({
  "AGENT_REPLACED": "read the takeover named in the refusal; only shout on that exact hand-off item, then continue work from the incoming agent worktree",
  "HANDOFF_WORKTREE": "join an agent worktree and run pullboard handoff there; the main checkout uses pullboard takeover",
  "HANDOFF_SELF": "join a different worktree as the incoming agent, then run pullboard handoff --take <id>",
  "HANDOFF_TAKEN": "read the recorded takeover and ask the incoming agent on the hand-off item before replacing another role",
  "NO_HANDOFF": "ask the outgoing agent to run pullboard handoff, then read and take the active item it prints"
}) });
