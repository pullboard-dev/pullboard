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

/** One inventory whose file map holds the given paths, the shape touchedCells reads the known cells from. */
const inventoryOf = files => ({ files: new Map(files.map(file => [file, Buffer.from('')])), edges: new Map() });

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
    assert.deepEqual(touchedCells([file], plan, plan, [inventoryOf([file])]), expected, `${file} with the plan rows`);
    assert.deepEqual(touchedCells([file], bare, bare, [inventoryOf([file])]), expected, `${file} with the plan rows removed`);
  }
  assert.deepEqual(touchedCells(files, bare, bare, [inventoryOf(files)]), touchedCells(files, plan, plan, [inventoryOf(files)]), 'all files together');
  assert.deepEqual(touchedCells(['README.md', 'tools/x.js'], bare, bare, [inventoryOf(files)]), [], 'a path in no cell folder names none');
});

/** A plan carrying stays and edited rows that name the file under test. */
const stayed = file => ({ cells: [{ name: 'noise', root: 'packages/noise', paths: [[file, file, 'seed']] }], stays: [{ path: file }] });

test('cli.io-submit-touched-cells-folder.c7-policyscope-reads-no-plan-stays-or-rows: clause 2: [C7] a plan stay or cells.json row edit no longer widens the touched set', () => {
  const file = 'packages/codemap/src/io/main.js';
  const expected = touchedCells([file], bare, bare, [inventoryOf([file])]);
  assert.deepEqual(expected, ['codemap'], 'the folder names the cell');
  assert.deepEqual(touchedCells([file], bare, stayed(file), [inventoryOf([file])]), expected, 'a stay on the file names no other cell');
  assert.deepEqual(touchedCells([file], stayed(file), plan, [inventoryOf([file])]), expected, 'an edited row names no other cell');
});

test('cli.io-submit-touched-cells-folder.c7-the-real-caller-keeps-its-cells-on-the-submit-gate: clause 3: [C7] shared policy still names every cell the folders show, through the four arguments', () => {
  const files = ['packages/codemap/src/io/main.js', 'apps/cli/src/io/main.js', 'packages/gate/src/io/main.js'];
  assert.deepEqual(touchedCells(['package.json'], bare, bare, [inventoryOf(files)]), ['app:cli', 'codemap', 'gate'], 'shared metadata still means all cells');
});
