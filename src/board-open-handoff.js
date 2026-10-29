import { agentById } from './seats.js';
import * as handoffMoves from './handoff.js';
import { atomic } from './board-event-log.js';
import { logEvent } from './board-event-log.js';
import { addItem } from './board-add-item.js';

/** Bind handoff creation to the native board writer and the same transaction [B3,N19,H16]. */
export function openHandoff(board, options) { return handoffMoves.openHandoff(board, options, { atomic, addItem, agentById, logEvent }); }
