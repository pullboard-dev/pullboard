import { agentById } from "../query.js";
import * as handoffMoves from "../../../../../items/index.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { addItem } from "../add.js";

/** Bind handoff creation to the native board writer and the same transaction [B3,N19,H16]. */
export function openHandoff(board, options) { return handoffMoves.openHandoff(board, options, { atomic, addItem, agentById, logEvent }); }
