/** The native generic item-field writer; status authority remains with moveItem [M1,C7]. */

/**
 * Write some of an item's fields, and its updated time. Field names come from this module only.
 *
 * @param {any} board
 * @param {number} id
 * @param {Record<string, string | number | null>} fields
 * @param {string | undefined} at An explicit captured native event instant; ordinary updates use the board clock.
 * @param {(board: any) => string} now The caller supplies its native clock reader.
 */
export function setItem(board, id, fields, at, now) {
  const keys = Object.keys(fields);
  const sets = keys.map((key) => `${key} = ?`).join(', ');
  board.db
    .prepare(`UPDATE item SET ${sets}, item_updated_at = ? WHERE item_id = ?`)
    .run(...keys.map((key) => fields[key]), at === undefined ? now(board) : at, id);
}

