/** The frozen row identity named by a landing [C7]. */
import { specOrder } from './message.js';

/**
 * The rows a landing names: the item's final frozen set when it has one, since a refreeze after the
 * claim is what the verdict checked, else its cited ids; in spec order when the spec is at hand.
 *
 * @param {any} item
 * @param {{ rows: { id: string }[] } | null} [spec]
 * @returns {string[]}
 */
export function landingRows(item, spec = null) {
  let frozen = null;
  try { frozen = item.item_frozen ? JSON.parse(item.item_frozen) : null; } catch { frozen = null; }
  const ids = Array.isArray(frozen?.rows)
    ? frozen.rows.map((row) => row.id)
    : String(item.item_spec_ids ?? '').split(/[\s,]+/u);
  return specOrder(ids.filter(Boolean), spec);
}
