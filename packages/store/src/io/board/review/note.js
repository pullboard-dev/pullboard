import { getItem } from "../query.js";
import { reviewHolder } from "../query.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { Refused } from "../../../../../kernel/index.js";

/** Validate a newly constructed review release while keeping old sealed replay executable [V1,R1,H16].
 * @param {any} board
 * @param {number} itemId
 * @param {string} agentId
 * @param {unknown} note
 * @returns {Refused | null}
 */
export function reviewReleaseNoteProblem(board, itemId, agentId, note) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < 5) return null;
  let item;
  try { item = getItem(board, itemId); }
  catch (error) {
    // Missing items keep their native, ordered refusal; this preflight only validates review notes.
    if (error instanceof Refused && error.code === 'NO_ITEM') return null;
    throw error;
  }
  if (item.item_status !== 'submitted' || reviewHolder(board, item) !== agentId) return null;
  const reason = typeof note === 'string' ? note.trim() : '';
  if (!reason || /[\r\n\u2028\u2029]/u.test(reason)) {
    return new Refused('NOTE_REQUIRED', 'give the review release a one-line reason with --note "..."');
  }
  return null;
}
