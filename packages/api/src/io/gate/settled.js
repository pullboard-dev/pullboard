/** The gate_settled event a settled gate job leaves once [C7,#12155]. */
import * as store from '../../../../store/index.js';

/**
 * Append one gate_settled event for a settled gate job: outcome green for a review with no main-owned failure, outcome red for a red.
 * Why: every settle path reaches applyGateReceipt, so one event here gives the timeline reader a settle per job [C7,#12155].
 * A main-owned review, an unknown, a stale and a not-gate result append nothing yet. A job that already has its event appends nothing,
 * so a receipt posted twice, or a sharded gate re-seen by settleWaitingGates, leaves one. The kind is not an engine-declared kind.
 *
 * @param {any} board
 * @param {string} job
 * @param {{ applied: boolean, outcome: string, mainOwned?: unknown }} applied - applyGateReceiptReads' answer.
 * @returns {typeof applied} the same answer.
 */
export function recordGateSettled(board, job, applied) {
  if (!applied?.applied) return applied;
  const settled = applied.outcome === 'review' && !('mainOwned' in applied) ? 'green' : applied.outcome === 'red' ? 'red' : null;
  if (!settled || typeof job !== 'string') return applied;
  store.atomic(board, () => {
    const item = board.db.prepare("SELECT job_item FROM job WHERE job_id = ? AND job_kind = 'gate'").get(job)?.job_item;
    if (!Number.isSafeInteger(item)) return;
    const seen = board.db.prepare("SELECT 1 FROM event WHERE event_kind = 'gate_settled' AND item_id = ? AND json_extract(event_detail, '$.job') = ?").get(item, job);
    if (!seen) store.logEvent(board, 'coordinator', 'gate_settled', item, { job, outcome: settled, class: 'item' });
  });
  return applied;
}
