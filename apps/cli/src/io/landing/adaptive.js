/** Adaptive landing batch size: behind landing.adaptiveBatch, the offer grows with clean batches and falls back after a stop [C7,#9017]. */
import { lineSettings } from '../../../../../packages/store/index.js';

/** Clean batches in a row that raise the size by one. */
const CLEAN_STREAK = 3;

/**
 * The size the next automatic offer takes, replayed from the landing batches' outcomes. Starts at 1; rises by one after
 * 3 clean batches in a row, never past `ceiling`; any stopped batch drops it back to 1. Why: a fixed cap is either slow
 * while main is healthy or too wide while it is not.
 *
 * @param {boolean[]} history - Oldest first; true when a batch landed every item with no stop.
 * @param {number} ceiling - The most items one batch may take.
 * @returns {number}
 */
export function adaptiveBatchSize(history, ceiling = Infinity) {
  let size = 1;
  let streak = 0;
  for (const clean of history) {
    if (!clean) { size = 1; streak = 0; continue; }
    streak += 1;
    if (streak === CLEAN_STREAK) { size = Math.min(size + 1, ceiling); streak = 0; }
  }
  return Math.min(size, ceiling);
}

/**
 * The finished landing batches' outcomes, oldest first, read from the board's run table; [] when it holds none.
 * A batch is clean when its job landed every item (outcome "landed"); any other outcome is a stop.
 */
export function landingHistory(db) {
  try {
    return db.prepare("SELECT run_outcome FROM run WHERE run_kind = 'land' AND run_outcome IS NOT NULL ORDER BY run_updated, rowid").all().map(row => row.run_outcome === 'landed');
  } catch { return []; }
}

/**
 * The most items one automatic land offer takes. With `adaptive` off: a set line.landingBatchSize, else no cap, as always.
 * On: the adaptive size, held under that setting when it is set.
 */
export function batchCap(board, { adaptive = false } = {}) {
  const size = lineSettings(board).landingBatchSize;
  const ceiling = Number.isSafeInteger(size) && size >= 1 ? size : Infinity;
  return adaptive ? adaptiveBatchSize(landingHistory(board.db), ceiling) : ceiling;
}
