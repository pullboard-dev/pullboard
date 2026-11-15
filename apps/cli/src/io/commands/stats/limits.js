/** Record a change to a machine setting that bounds work on the board the command runs in [C7,#6139]. */
import { lastLimit } from '../../../../../../packages/stats/index.js';
import { recordLimitEvent } from '../../../../../../packages/stats/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';

/**
 * Run work on the command's board; undefined when it runs outside a Pullboard repository.
 * Why: the machine setting still changes there, there is simply no board to record it on. The caller passes how to
 * open the board, so this module imports no command plumbing and cannot join the CLI's import cycle.
 */
function onBoard(open, work) {
  try { return open(work); }
  catch (error) { if (error instanceof Refused) return undefined; throw error; }
}

/**
 * Record a limit's change as a board event; nothing when the value did not change or there is no board.
 *
 * @param {(work: (board: any) => any) => any} open - Runs work on the command's board, as withBoard does.
 * @param {string} key - gateSlots, workers.budget or runner.jobs.
 * @param {unknown} before
 * @param {unknown} after
 * @param {{ atomic: Function, logEvent: Function }} store - Store's write primitives, from the caller's existing store import.
 * @returns {boolean} whether an event was written.
 */
export function recordLimitChange(open, key, before, after, store) {
  return onBoard(open, board => recordLimitEvent(board, key, before, after, store)) ?? false;
}

/** The newest value recorded for a limit on the command's board, or null. */
export function lastRecordedLimit(open, key) {
  return onBoard(open, board => lastLimit(board.db, key)) ?? null;
}
