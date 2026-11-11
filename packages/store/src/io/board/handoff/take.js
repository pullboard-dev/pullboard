import { agentById } from "../query.js";
import * as handoffMoves from "../../../../../items/index.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { appendFact } from "../fact.js";

/** Bind handoff takeover to native reads, writes and fact custody [B3,N19,H16]. */
export function takeHandoff(board, options) { return handoffMoves.takeHandoff(board, options, { atomic, agentById, logEvent, appendFact }); }
