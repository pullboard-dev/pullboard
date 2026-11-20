/** The coordinator's expedite mark on an item, and the set of items still expedited: one event per call, read back with no new table [C7,#12295]. */
import { itemById } from "./query.js";
import { logEvent } from "./event/log.js";

/**
 * Append exactly one expedite event to an item and write nothing else.
 * Why: the count of expedited items (jobs.expediteMax) is checked by the command above the store; the store only records the call.
 *
 * @param {object} board - An open board.
 * @param {number} id - The item to expedite; an id that does not exist is refused with no event.
 * @param {{ agentId: string, reason: string }} expedite
 * @returns {void}
 */
export function expediteItem(board, id, { agentId, reason }) {
  itemById(board, id);
  logEvent(board, agentId, 'expedite', id, { reason });
}

/**
 * The items with an expedite event and no gate verdict recorded after it, by id.
 * Why: an item stops being expedited once its gate settles, so the set empties itself with no clear step; a gate verdict is the applied receipt of a gate job.
 *
 * @param {object} board - An open board.
 * @returns {number[]}
 */
export function expeditedItems(board) {
  return board.db.prepare(`SELECT DISTINCT e.item_id AS id FROM event e WHERE e.event_kind = 'expedite' AND e.item_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM event v WHERE v.item_id = e.item_id AND v.event_kind = 'run_applied' AND v.event_id > e.event_id
      AND json_extract(v.event_detail, '$.job') LIKE 'gate:%')
    ORDER BY e.item_id`).all().map(row => row.id);
}
