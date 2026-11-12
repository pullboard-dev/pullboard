/** Record a change to a machine setting that bounds work on the board the command runs in [C7,#6139]. */
import { lastLimit } from '../../../../../../packages/stats/index.js';
import { recordLimitEvent } from '../../../../../../packages/stats/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { context } from '../../read.js';
import { withBoard } from '../../entry.js';

/**
 * Run work on this command's board; undefined when it runs outside a Pullboard repository.
 * Why: the machine setting still changes there, there is simply no board to record it on.
 */
function onBoard(io, work) {
  try { return withBoard(context(io), work); }
  catch (error) { if (error instanceof Refused) return undefined; throw error; }
}

/**
 * Record a limit's change as a board event; nothing when the value did not change or there is no board.
 *
 * @param {any} io - The command's io.
 * @param {string} key - gateSlots, workers.budget or runner.jobs.
 * @param {unknown} before
 * @param {unknown} after
 * @returns {boolean} whether an event was written.
 */
export function recordLimitChange(io, key, before, after) {
  return onBoard(io, board => recordLimitEvent(board, key, before, after)) ?? false;
}

/** The newest value recorded for a limit on this command's board, or null. */
export function lastRecordedLimit(io, key) {
  return onBoard(io, board => lastLimit(board.db, key)) ?? null;
}
