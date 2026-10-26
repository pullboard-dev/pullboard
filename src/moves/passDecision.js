import { laneAnswerFloor } from '../lane-lead.js';
import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by passDecision, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  const laneFloor = laneAnswerFloor(board, args);
  if (laneFloor > 1) return laneFloor;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "passDecision", order: 24, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ALREADY_ANSWERED": "read the answer with pullboard inbox; ask again with a new pullboard shout <to> \"<text>\" --decision",
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator \"<what you need>\"",
  "EMPTY_NOTE": "say why: pullboard pass <id> --note \"<reason>\"",
  "NOT_COORDINATOR_DECISION": "list open decisions with pullboard decisions and answer one of those"
}) });
