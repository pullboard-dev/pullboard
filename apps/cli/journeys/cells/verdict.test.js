/** A cell's verdict is reused unless its own closure or policy row changed [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { touchedCells } from '../../index.js';

/** Build a plan cell with a shard-ordered identity and one placed path. */
function cell(order, name, extra = {}) {
  return { order, name, root: `packages/${name}`, frontDoor: `packages/${name}/index.js`, paths: [[`src/${name}.js`, `packages/${name}/src/core/${name}.js`]], ...extra };
}
const plan = { version: 1, item: 1, cells: [cell(1, 'a'), cell(2, 'b'), cell(3, 'c')] };
const quiet = { edges: new Map() };

test('a change to one cell policy row reruns that cell and reuses every other cell [C7,D3,CD64]', () => {
  const edited = { ...plan, cells: [plan.cells[0], cell(2, 'b', { cuts: [{ note: 'x' }] }), plan.cells[2]] };
  assert.deepEqual(touchedCells(['packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan/02-b.json'], plan, edited, [quiet, quiet]), ['b']);
  assert.deepEqual(touchedCells(['packages/codemap/data/plan/path-map/c.json'], plan, plan, [quiet]), ['c']);
  assert.deepEqual(touchedCells(['packages/codemap/data/baselines/lints/cells/a.json'], plan, plan, [quiet]), ['a']);
});

test('a change that alters a cell closure still reruns that cell and a global edit reruns all [C7,D3,CD64]', () => {
  const importer = { edges: new Map([['src/c.js', [{ target: 'src/a.js' }]]]) };
  assert.deepEqual(touchedCells(['src/a.js'], plan, plan, [importer]), ['a', 'c']);
  const settings = { ...plan, item: 2 };
  assert.deepEqual(touchedCells(['packages/codemap/data/plan/cells.json'], plan, settings, [quiet]), ['a', 'b', 'c'], 'a plan-wide setting is shared');
  assert.deepEqual(touchedCells(['packages/codemap/data/plan/cells.json'], plan, plan, [quiet]), ['a', 'b', 'c'], 'an index edit naming no row fails safe');
  assert.deepEqual(touchedCells(['packages/codemap/data/plan/temporary-edges.json'], plan, plan, [quiet]), ['a', 'b', 'c']);
  assert.deepEqual(touchedCells(['package.json'], plan, plan, [quiet]), ['a', 'b', 'c']);
});
