import { laneMessageFloor } from '../lane-lead.js';
import { DECISION_QUEUE_ENGINE } from '../decision-queue-engine.js';
import { ACTIVITY_NEWS_ENGINE } from '../activity-news-engine.js';
import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by shout, discovered without a shared registry edit [C7,V4,H16]. */
import { ITEM_SHOUT_ENGINE } from '../item-shout-engine.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function historicalMinimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.item !== undefined) return ITEM_SHOUT_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/** News combines every applicable floor; old arguments retain their historical replay condition order. */
function minimumEngine(args, board, at) {
  const laneFloor = laneMessageFloor(board, args[0]);
  const optionsFloor = args[0]?.options !== undefined ? DECISION_QUEUE_ENGINE : 1;
  if (args[0]?.news !== true) return Math.max(laneFloor, optionsFloor, historicalMinimumEngine(args, board, at));
  return Math.max(laneFloor, optionsFloor, ACTIVITY_NEWS_ENGINE,
    typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:') ? RIGOR_AUTO_ENGINE : 1,
    args[0]?.item !== undefined ? ITEM_SHOUT_ENGINE : 1,
    args[0]?.landingFence !== undefined ? LANDING_LEASE_ENGINE : 1,
    typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:') ? BOARD_SENTINEL_ENGINE : 1);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.from ?? null; }

export default Object.freeze({ operation: "shout", order: 23, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  BAD_MESSAGE_KIND: 'use --kind question, blocker or decision',
  STATUS_IS_ACTIVITY: 'keep working on the item; status is board activity, not a shout',
  LANE_MESSAGE_ITEM: 'omit --kind for an item-specific message',
  NOT_LANE_LEAD: 'ask your named lane lead to send the decision upward',
  "B26_PERSON_CHANNEL": "record it as the person through pullboard view or the person's own terminal",
  "B26_PERSON_DECISION": "ask your coordinator: pullboard shout coordinator \"<question>\" --decision",
  "BAD_DECISION_OPTIONS": "ask an item decision with --decision --item <id> --options '[\"first\",\"second\"]'",
  "NOT_YOUR_ITEM_DECISION": "ask on an item you build or review, or ask the coordinator for a cross-item decision",
  "BAD_EVIDENCE": "pass the evidence fields the message names, then retry",
  "BAD_NEWS": "send news from the coordinator or person to all, without item, decision, request or answer",
  "BAD_REQUEST": "send the request body the message names as an application/json object",
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator \"<what you need>\"",
  "EMPTY_SHOUT": "give the shout text: pullboard shout <to> \"<text>\"",
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "NOT_A_DECISION": "reply with a shout: pullboard shout <to> \"<text>\"",
  "NO_READER": "name a lane, an agent or all: pullboard shout all \"<text>\"",
  "NO_SHOUT": "name a shout id from pullboard inbox",
  "REQUEST_CLOSED": "read pullboard inbox before answering another request",
  "REQUEST_OUTCOME": "pullboard answer <id> done \"<reason>\", or pullboard answer <id> declined \"<reason>\"",
  "SHOUT_TOO_LONG": 'shorten the message to 400 characters or fewer; cite native proof receipt ids and read pullboard show <id> for the evidence chain',
  "SELF_SHOUT": "name another agent, a lane or all: pullboard shout all \"<text>\""
}) });
