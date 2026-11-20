/** The pace an item was admitted under, as the store reads it: the one reader of the frozen pace on the store's side of the moves cell [V2,M1]. */

/** The paces a board may set; steady is the default and today's landing. */
const PACES = Object.freeze(['sprint', 'steady', 'strict']);

/**
 * The item's frozen pace, or steady when its bar holds none (frozen before paces, or under steady) or the frozen text is damaged.
 * Why one reader: the merged writer, the verify snapshot and the reopen writer each decide by the pace, and private copies drifted (one read strict only, so a sprint item was decided as steady).
 * Why here and not the moves cell's itemPace: the moves cell imports the store, so the store cannot import it back; this reads the frozen bar the same way.
 * It reads the item row already loaded, never the board, so no pace adds a board statement.
 *
 * @param {{ item_frozen?: string | null } | null | undefined} row - The item row.
 * @returns {'sprint' | 'steady' | 'strict'}
 */
export function itemPace(row) {
  let frozen = null;
  try { frozen = row?.item_frozen ? JSON.parse(row.item_frozen) : null; } catch { frozen = null; }
  return PACES.includes(frozen?.pace) ? frozen.pace : 'steady';
}
