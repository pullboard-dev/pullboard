import { itemFiles } from "../../../items/index.js";

/** A path's cell, the codemap cell rule kept here so selection and claim load no further module [C7,#8907]. */
export function cellOfPath(path) {
  return /^(?:apps|packages)\/[^/]+(?=\/)/u.exec(path)?.[0] ?? null;
}

/**
 * The cells another seat holds, each with the holding item and seat, from live claims whose brief names a file in it.
 * Why one reader: `next` hides items in these cells and an explicit claim refuses them, and the two must never differ [C7,#2830].
 *
 * @param {any} board
 * @param {string} agentId - The seat that asks; its own claims never hold a cell against it.
 * @returns {Map<string, { itemId: number, holder: string }>}
 */
export function heldCells(board, agentId) {
  const now = board.clock.now().toISOString();
  const held = new Map();
  for (const item of board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner<>? AND item_lease_until>?").all(agentId, now)) {
    for (const file of itemFiles(item)) {
      const cell = cellOfPath(file);
      if (cell && !held.has(cell)) held.set(cell, { itemId: item.item_id, holder: item.item_owner });
    }
  }
  return held;
}
