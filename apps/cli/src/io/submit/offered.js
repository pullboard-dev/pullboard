/** A pull-mode submit's own instant: one submit_offered event when it offers a new gate job, since the submit event waits for the status move [C7]. */
import { logEvent } from '../../../../../packages/store/index.js';

/**
 * Append one submit_offered event for the gate job a submit just offered; a job already recorded as offered writes nothing.
 * Why: the board's submit event is written when the item's status moves, so only this event holds when the builder ran submit.
 *
 * @param {any} board
 * @param {{ item: number, by: string, commit: string, job: string, main: string }} offer - by: the submitting agent; job: the gate job id; main: the main commit the job was offered on.
 * @returns {boolean} Whether an event was appended.
 */
export function recordSubmitOffered(board, { item, by, commit, job, main }) {
  const known = board.db.prepare("SELECT 1 FROM event WHERE item_id = ? AND event_kind = 'submit_offered' AND json_extract(event_detail, '$.job') = ? LIMIT 1").get(item, job);
  if (known) return false;
  logEvent(board, by, 'submit_offered', item, { commit, job, main });
  return true;
}
