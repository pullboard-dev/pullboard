import { agentById } from './seats.js';
import * as handoffMoves from './handoff.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { appendFact } from './board-append-fact.js';

/** Bind handoff takeover to native reads, writes and fact custody [B3,N19,H16]. */
export function takeHandoff(board, options) { return handoffMoves.takeHandoff(board, options, { atomic, agentById, logEvent, appendFact }); }
