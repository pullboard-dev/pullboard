/** judgeSummary folds per-table judge counts into rows, new tables, drifted tables and a clean verdict [C7,R4,U150]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeSummary } from '../../../index.js';

const counts = (over) => ({ same: 0, currentDrifted: 0, releasedWrong: 0, bothDiffer: 0, ...over });
const judged = (table, over) => ({ table, judge: { against: 'v0.9.5', counts: counts(over) } });

test('moves.judge-summary.rows-new-drifted: clause 1: judgeSummary lists judged tables in name order, new tables, drifted tables and clean false [C7,R4]', () => {
  const out = judgeSummary([judged('c', { releasedWrong: 3 }), { table: 'd', missing: true }, judged('b', { bothDiffer: 2 }), judged('a', { currentDrifted: 1 })]);
  assert.deepEqual(out.rows.map((r) => r.table), ['a', 'b', 'c']);
  assert.equal(out.rows[0].against, 'v0.9.5');
  assert.equal(out.rows[2].counts.releasedWrong, 3);
  assert.deepEqual(out.newTables, ['d']);
  assert.deepEqual(out.drifted, ['a', 'b']);
  assert.equal(out.clean, false);
});

test('moves.judge-summary.clean-and-empty: clause 2: judgeSummary is clean when only same and released-wrong are counted, and over no tables [C7,R4]', () => {
  const out = judgeSummary([judged('a', { same: 4 }), judged('b', { releasedWrong: 2, same: 1 })]);
  assert.deepEqual(out.drifted, []);
  assert.equal(out.clean, true);
  assert.deepEqual(judgeSummary([]), { rows: [], newTables: [], drifted: [], clean: true });
});

test('moves.judge-summary.order-free-and-pure: clause 3: judgeSummary gives the same result in any order and leaves its array unchanged [C7,R4]', () => {
  const tables = [judged('c', { same: 1 }), { table: 'z', missing: true }, judged('a', { currentDrifted: 1 }), judged('b', { bothDiffer: 1 })];
  const before = JSON.stringify(tables);
  const results = new Set([tables, [...tables].reverse(), [...tables].sort((x, y) => x.table.localeCompare(y.table))].map((t) => JSON.stringify(judgeSummary(t))));
  assert.equal(results.size, 1);
  assert.equal(JSON.stringify(tables), before);
});
