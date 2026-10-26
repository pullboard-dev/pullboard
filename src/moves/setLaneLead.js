/** Coordinator-owned lane policy is an ordered board move [B21,H16]. */
import { LANE_LEAD_ENGINE } from '../lane-lead-engine.js';
/** Policy changes require every replica to understand the lead protocol. */
function minimumEngine() { return LANE_LEAD_ENGINE; }
/** Read the authenticated actor from the operation's sole argument. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: 'setLaneLead', order: 1000, engine: LANE_LEAD_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({ COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator \"<what you need>\"',
    BAD_LANE_LEAD: 'name a configured lane and an existing seat in that lane, or off' }) });
