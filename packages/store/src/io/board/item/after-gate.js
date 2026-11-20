/** The after-gate list: prerequisites an item waits on until their gate is green, kept apart from plain --after ids [C7]. */
import { itemById } from "../query.js";
import { atomic } from "../event/log.js";
import { setItem } from "../../board.js";
import { deleteBoardMeta } from "../meta.js";
import { readBoardMeta } from "../meta.js";
import { writeBoardMeta } from "../meta.js";
import { validateItemDependencies } from "./dependencies.js";
import * as itemDependencies from "../../../../../items/index.js";

/** The ids an item waits on through the after-gate list; a plain --after id never appears here. */
export function afterGateIds(board, id) {
  const value = readBoardMeta(board.db, `after_gate:${id}`);
  if (value === undefined) return [];
  try {
    const ids = JSON.parse(value);
    return Array.isArray(ids) ? ids.filter(Number.isInteger) : [];
  } catch { return []; }
}

/**
 * Set an item's after-gate list: the ids join item_after, so every reader of the list sees them, and the same ids are marked under board_meta after_gate:<id>.
 * Why: the marker says which waits came from the gate list, so replacing or clearing it leaves the item's plain --after ids alone.
 * The combined list passes the same checks as --after: an unknown or withdrawn id is refused, and an id that reaches the item through its own dependencies is DEPENDENCY_CYCLE.
 *
 * @param {any} board
 * @param {number} id
 * @param {number[]} ids
 * @returns {number[]} The ids now in the after-gate list.
 */
export function setAfterGate(board, id, ids) {
  itemDependencies.validateNativeDependencies(ids);
  const gate = [...new Set(ids)];
  return atomic(board, () => {
    const item = itemById(board, id);
    const previous = new Set(afterGateIds(board, id));
    const plain = itemDependencies.dependencyValues(item.item_after).filter(value => !previous.has(value));
    const combined = [...plain, ...gate.filter(value => !plain.includes(value))];
    validateItemDependencies(board, id, combined);
    setItem(board, id, { item_after: combined.join(',') });
    if (gate.length) writeBoardMeta(board.db, `after_gate:${id}`, JSON.stringify(gate));
    else deleteBoardMeta(board.db, `after_gate:${id}`);
    return gate;
  });
}
