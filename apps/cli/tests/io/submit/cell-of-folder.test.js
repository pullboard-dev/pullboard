/** @pullboard-test-input packages/codemap/data/plan/** */
/** A module path's cell is derived from its folder alone and matches the restructure plan [C7,#8554]. */
import assert from 'node:assert/strict';
import {
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellOfFolder } from '../../../src/logic/cell-of-folder.js';

const PLAN = join(import.meta.dirname, '../../../../../packages/codemap/data/plan');

test('cli.io-submit-cell-of-folder.c7-the-cell-derived-from-a-folder: clause 1: [C7] the cell derived from a folder matches the plan cell for every row on main', () => {
  let rows = 0;
  for (const file of readdirSync(PLAN).filter(name => /^\d+-.*\.json$/.test(name))) {
    const cell = JSON.parse(readFileSync(join(PLAN, file), 'utf8'));
    for (const row of cell.paths) {
      rows += 1;
      assert.equal(cellOfFolder(row[1]), cell.name, `${row[1]} belongs to ${cell.name}`);
    }
  }
  assert.ok(rows > 1000, 'the plan on main has rows to check');
  assert.equal(cellOfFolder('packages/kernel/index.js'), 'kernel');
  assert.equal(cellOfFolder('apps/cli/src/logic/census.js'), 'app:cli');
  assert.equal(cellOfFolder('README.md'), null);
});
