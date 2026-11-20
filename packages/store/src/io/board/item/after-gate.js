/** The after-gate list: prerequisites an item waits on until their gate is green, kept apart from plain --after ids [C7]. */
import { itemById } from "../query.js";
import { atomic } from "../event/log.js";
import { setItem } from "../../board.js";
import { deleteBoardMeta } from "../meta.js";
import { readBoardMeta } from "../meta.js";
import { writeBoardMeta } from "../meta.js";
import { validateItemDependencies } from "./dependencies.js";
import { submitHandoff } from "../../submit/handoff/records.js";
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

/**
 * Whether an after-gate parent is submitted and its gate went green at its submitted head [C7].
 * Why a copy of next.js greenAtHead: the claim path must not import the review queue's module.
 *
 * @param {any} board
 * @param {number} parentId
 * @returns {boolean}
 */
export function gateGreenParent(board, parentId) {
  const parent = itemById(board, parentId);
  if (parent?.item_status !== 'submitted') return false;
  const job = submitHandoff(board, parentId);
  return Boolean(job && parent.item_commit && job.commit === parent.item_commit && job.state === 'green');
}

/**
 * The after-gate parent a claim of this item builds on and the head it was submitted at, or null when no parent is waiting on its merge.
 *
 * @param {any} board
 * @param {number} id
 * @returns {{ parent: number, head: string } | null}
 */
export function afterGateBase(board, id) {
  for (const parent of afterGateIds(board, id)) {
    if (gateGreenParent(board, parent)) return { parent, head: itemById(board, parent).item_commit };
  }
  return null;
}
