/** Recorded verdict rows in order, read by seat route escalation and the verify cell above it [B15,V1,C7]. */

/**
 * Every verdict recorded for an item, oldest first, exactly as stored.
 *
 * Route escalation reads only the stored decision and its recorded fields, so it shares this row
 * read rather than loading the verify cell's withdrawal and assurance projection.
 *
 * @param {any} board
 * @param {number} id
 * @returns {any[]}
 */
export function verdictRows(board, id) {
  return board.db.prepare('SELECT * FROM verdict WHERE item_id = ? ORDER BY verdict_id').all(id);
}
