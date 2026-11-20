/** The after-gate list: prerequisites an item waits on until their gate is green, kept apart from plain --after ids [C7]. */
import { itemById } from "../query.js";
import { atomic } from "../event/log.js";
import { setItem } from "../../board.js";
import { deleteBoardMeta } from "../meta.js";
import { readBoardMeta } from "../meta.js";
import { writeBoardMeta } from "../meta.js";
import { listBoardMetaWithPrefix } from "../meta.js";
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

/** The parent and head an item's claim recorded for its after-gate base, or null when it has none. */
function recordedBase(board, id) {
  try {
    const record = JSON.parse(readBoardMeta(board.db, `after_gate_base:${id}`) ?? 'null');
    return record && typeof record === 'object' ? record : null;
  } catch { return null; }
}

/** The ids of the items whose after-gate list names this parent; a plain --after dependent has no marker and never appears. */
export function afterGateDependents(board, parentId) {
  return listBoardMetaWithPrefix(board.db, 'after_gate:').flatMap(({ key, value }) => {
    let ids = [];
    try { ids = JSON.parse(value); } catch { return []; }
    return Array.isArray(ids) && ids.includes(parentId) ? [Number(key.slice('after_gate:'.length))] : [];
  }).filter(Number.isInteger);
}

/**
 * Send back each dependent built on a rejected after-gate parent [C7,#11807]. A submitted dependent is reopened, a verified one that has not landed has its
 * acceptance withdrawn and is reopened, and a claimed one is released by its holder; each carries a note naming the parent. A dependent that already
 * landed gets a notice fact and no reopen. A dependent the board refuses to send back gets a notice fact naming the refusal, so the parent's verdict still records.
 * With `head`, the parent was resubmitted at that commit instead of rejected: only a dependent whose after_gate_base for this parent holds another head goes back, with a note naming both heads [C7,#11808].
 * Why injected: reopen and release belong to modules the claim path, which loads this file, must not import.
 *
 * @param {any} board
 * @param {number} parentId
 * @param {{ cause?: string, head?: string }} [options]
 * @param {{ reopen: Function, release: Function, appendFact: Function }} [ports]
 * @returns {{ id: number, action: 'reopened' | 'released' | 'notified' | 'refused' }[]}
 */
export function sendBackDependents(board, parentId, { cause, head } = {}, { reopen, release, appendFact } = {}) {
  const sent = [];
  for (const id of afterGateDependents(board, parentId)) {
    const item = itemById(board, id);
    if (!item || ['open', 'withdrawn'].includes(item.item_status)) continue;
    const built = head === undefined ? null : recordedBase(board, id);
    if (head !== undefined && !(built?.parent === parentId && built.head && built.head !== head)) continue;
    const note = head === undefined ? `parent #${parentId} was rejected, so this work built on it goes back`
      : `parent #${parentId} moved from ${built.head} to ${head}, so this work built on the old head goes back`;
    const tell = text => appendFact(board, id, { agentId: 'coordinator', kind: 'note', text });
    try {
      if (item.item_merged_commit) { tell(`${note}, but it already landed as ${item.item_merged_commit}; nothing is reopened`); sent.push({ id, action: 'notified' }); continue; }
      if (item.item_status === 'submitted') reopen(board, id, { agentId: 'coordinator', note, ...(cause ? { cause } : {}) });
      else if (item.item_status === 'verified') reopen(board, id, { agentId: 'coordinator', note, withdrawVerdict: true, ...(cause ? { cause } : {}) });
      else if (item.item_status === 'claimed') release(board, id, item.item_owner, note, 'OTHER');
      else continue;
      sent.push({ id, action: item.item_status === 'claimed' ? 'released' : 'reopened' });
    } catch (error) {
      if (!error?.code) throw error;
      tell(`${note}, but the board refused to send it back: ${error.code}`); sent.push({ id, action: 'refused' });
    }
  }
  return sent;
}
