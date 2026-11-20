/** One mark event for an item: the stage, edge, reason and ref a seat or the board names, appended with no read of past events [C7,#12157]. */
import { itemById } from "./query.js";
import { logEvent } from "./event/log.js";

/**
 * Append exactly one mark event to an item and write nothing else.
 * Why: the store does not check stage or reason against the closed lists; they live in the stats cell and the cli command checks them.
 *
 * @param {object} board - An open board.
 * @param {number} id - The item the mark is for; an id that does not exist is refused with no event.
 * @param {{ agentId: string, stage: string, edge: string, reason: string|null, ref: string|null, at: number, id?: string }} mark
 * @returns {void}
 */
export function appendMark(board, id, { agentId, stage, edge, reason, ref, at, id: markId }) {
  itemById(board, id);
  logEvent(board, agentId, 'mark', id, { stage, edge, reason, ref, at, ...(markId === undefined ? {} : { id: markId }) });
}
