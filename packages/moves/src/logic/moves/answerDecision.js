import { laneAnswerFloor } from "../../../../seats/browser.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by answerDecision, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { IMPLIES_ENGINE } from "../../../../state/light.js";
import { DECISION_ORIGIN_ENGINE } from "../../../../state/light.js";
import { carriesOrigin } from "../../../../items/browser.js";
import { carriesImplies } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function historicalMinimumEngine(args, board, at) {
  const laneFloor = laneAnswerFloor(board, args);
  if (laneFloor > 1) return laneFloor;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (carriesImplies('answerDecision', args)) return IMPLIES_ENGINE;
  return 1;
}

/** New provenance composes with every older option; clause-free recorded moves keep their selection [H16]. */
function minimumEngine(args, board, at) {
  return Math.max(historicalMinimumEngine(args, board, at), carriesOrigin(args) ? DECISION_ORIGIN_ENGINE : 1);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "answerDecision", order: 25, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ALREADY_ANSWERED": "read the answer with pullboard inbox; ask again with a new pullboard shout <to> \"<text>\" --decision",
  "B26_PERSON_ANSWER": "ask your coordinator to answer or pass the decision: pullboard shout coordinator --kind question \"<question>\" --decision",
  "NOT_A_DECISION": "reply with a shout: pullboard shout <to> \"<text>\"",
  "BAD_ORIGIN": "name where the decision came from with --origin person-relayed, agent or inherited, or leave --origin out",
  "NOT_YOUR_DECISION": "answer only decisions addressed to you; see pullboard inbox"
}) });
