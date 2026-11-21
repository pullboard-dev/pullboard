import { STAKES } from './grammar.js';

/**
 * The ids of the rows whose stakes rank rose between two parses of one spec, in the after rows' order. A row counts only
 * when it is in both lists; a lowered, unchanged, added or deleted row does not. Why: a raise from low to team or
 * critical means an approval given on the old record no longer covers the row, and a later step marks the items that cite
 * it for a refreeze.
 *
 * @param {Array<{ id: string, stakes?: string }>} beforeRows
 * @param {Array<{ id: string, stakes?: string }>} afterRows
 * @returns {string[]}
 */
export function raisedStakesRows(beforeRows, afterRows) {
  const rank = (row) => STAKES.indexOf(row.stakes ?? 'team');
  const before = new Map(beforeRows.map((row) => [row.id, rank(row)]));
  return afterRows.filter((row) => before.has(row.id) && rank(row) > before.get(row.id)).map((row) => row.id);
}
