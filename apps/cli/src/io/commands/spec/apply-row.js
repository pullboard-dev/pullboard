/** spec apply --row <id>: narrow an apply to one row's pending decision [C7]. */
import { Refused } from '../../../../../../packages/kernel/index.js';

/**
 * The decisions an apply may act on: all of them, or only the pending ones for one row.
 * An id with no pending decision is refused, never a silent no-op, so a typo cannot look like success.
 *
 * @param {object[]} decisions the board's row decisions
 * @param {string | undefined} rowId the --row value, if given
 * @returns {object[]}
 */
export function rowDecisionsFor(decisions, rowId) {
  if (rowId === undefined) return decisions;
  if (typeof rowId !== 'string' || !rowId.trim()) throw new Refused('USAGE', '--row needs a row id', 'pullboard spec apply --row <id>');
  const mine = decisions.filter(record => record.id === rowId && !record.applied);
  if (!mine.length) throw new Refused('USAGE', `${rowId} has no pending decision to apply`, 'pullboard spec');
  return decisions.filter(record => record.applied || record.id === rowId);
}
