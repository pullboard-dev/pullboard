/** The native generic item-field writer; status authority remains with moveItem [M1,C7]. */
import { now } from './board-query.js';

/**
 * Write some of an item's fields, and its updated time. Field names come from this module only.
 *
 * @param {any} board
 * @param {number} id
 * @param {Record<string, string | number | null>} fields
 * @param {string} [at] An explicit captured native event instant; ordinary updates use the board clock.
 */
export function setItem(board, id, fields, at) {
  const keys = Object.keys(fields);
  const sets = keys.map((key) => `${key} = ?`).join(', ');
  board.db
    .prepare(`UPDATE item SET ${sets}, item_updated_at = ? WHERE item_id = ?`)
    .run(...keys.map((key) => fields[key]), at === undefined ? now(board) : at, id);
}

