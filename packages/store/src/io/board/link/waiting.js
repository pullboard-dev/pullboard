/** Which parent items wait on a child board's items, read from the parent's own item rows [RB24]. */
import { foreignDependencies } from '../../../../../items/index.js';

/** A parent item in these states no longer waits on anything. */
const DONE = new Set(['verified', 'withdrawn']);

/**
 * Map each child item id to the sorted ids of the open parent items that name it as childHandle#id in their after list.
 * Why: the child board stores no foreign-wait data, so it learns who waits on it from the parent's item_after rows alone; a local or other-handle dependency is not a wait on this child.
 *
 * @param {{ item_id: number, item_status: string, item_after?: unknown }[]} parentItems - Rows of the parent board.
 * @param {string} childHandle - The child board's repository name as the parent writes it.
 * @returns {Map<number, number[]>}
 */
export function waitedOnItems(parentItems, childHandle) {
  const waiting = new Map();
  for (const item of parentItems) {
    if (DONE.has(item.item_status)) continue;
    for (const ref of foreignDependencies(item)) {
      if (ref.repo !== childHandle) continue;
      const parents = waiting.get(ref.id) ?? new Set();
      parents.add(item.item_id);
      waiting.set(ref.id, parents);
    }
  }
  return new Map([...waiting].map(([id, parents]) => [id, [...parents].sort((a, b) => a - b)]));
}
