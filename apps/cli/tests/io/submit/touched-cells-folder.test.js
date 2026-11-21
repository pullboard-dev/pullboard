/** @pullboard-test-input packages/codemap/data/plan/** */
/** touchedCells names the same cells from folders as from the plan's path rows [C7,#8555]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { touchedCells } from '../../../src/io/cells-submit-checks.js';

const PLAN = join(import.meta.dirname, '../../../../../packages/codemap/data/plan');
const cells = readdirSync(PLAN).filter(name => /^\d+-.*\.json$/.test(name)).map(file => JSON.parse(readFileSync(join(PLAN, file), 'utf8')));
const plan = { cells };
/** The same plan with every path row removed: only folders, roots and doors are left to name a cell. */
const bare = { cells: cells.map(cell => ({ ...cell, paths: [] })) };

/** The old attribution, which scanned every cell's rows for each file. */
function planOwners(file) {
  return plan.cells.filter(cell => file === cell.frontDoor || file === cell.pureFrontDoor || file === cell.lightFrontDoor
    || file === cell.pureDoor || file.startsWith(cell.root + '/') || cell.paths.some(row => row[0] === file || row[1] === file)).map(cell => cell.name);
}

test('cli.io-submit-touched-cells-folder.c7-touchedcells-returns-the-same-cells-from: clause 1: [C7] touchedCells returns the same cells from folders as from the plan rows, with the rows removed', () => {
  const files = [...new Set(cells.flatMap(cell => [cell.frontDoor, cell.pureFrontDoor, cell.lightFrontDoor, cell.pureDoor, ...cell.paths.map(row => row[1])]).filter(Boolean))];
  assert.ok(files.length > 1000, 'the plan on main has rows to attribute');
  for (const file of files) {
    const expected = planOwners(file).sort();
    assert.deepEqual(touchedCells([file], plan, plan, []), expected, `${file} with the plan rows`);
    assert.deepEqual(touchedCells([file], bare, bare, []), expected, `${file} with the plan rows removed`);
  }
  assert.deepEqual(touchedCells(files, bare, bare, []), touchedCells(files, plan, plan, []), 'all files together');
  assert.deepEqual(touchedCells(['README.md', 'packages/nonexistent/index.js'], bare, bare, []), [], 'a path in no planned cell names none');
});
