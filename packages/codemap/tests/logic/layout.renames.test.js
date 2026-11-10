/** @pullboard-world-pin reads the committed rename table to prove it is complete and clean under the layout rules. */
/**
 * The rename table for the layout freeze keeps its promises [V32,V33]: one row per old path, no two files mapped to one
 * new path, every merge target present, and the layout rules find nothing in the new paths but the plan data group.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { layoutViolations } from '../../src/core/layout.js';

const rows = readFileSync(new URL('../../data/renames.tsv', import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => line.split('\t'));
const moved = rows.filter(([, to]) => to !== 'delete' && !to.startsWith('merge:')).map(([, to]) => to);

test('every old path has one row and every row names a new path, a delete or a merge [V32,V33]', () => {
  assert.equal(new Set(rows.map(([from]) => from)).size, rows.length);
  for (const row of rows) assert.ok(row.length === 2 || (row.length === 3 && row[1] === 'delete'), row.join(' '));
});

test('no two files map to one new path and every merge joins a file that exists [V32,V33]', () => {
  assert.equal(new Set(moved).size, moved.length);
  for (const [from, to] of rows.filter(([, to]) => to.startsWith('merge:'))) assert.ok(moved.includes(to.slice('merge:'.length)), from);
});

test('the layout rules over the new paths report nothing but the plan data group [V32,V33]', () => {
  const found = layoutViolations(moved).filter(({ rule, key }) => !(rule === 'data-group' && key === 'packages/codemap/data/plan'));
  assert.deepEqual(found, []);
});
