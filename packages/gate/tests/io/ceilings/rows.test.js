/** The gate names the source ceiling tables a lane may move rows in, and judges a moved row against the staged rows [L3,C7,#10242]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CEILING_ROW_TABLES } from '../../../heavy.js';
import { STATIC_CHECKS } from '../../../heavy.js';
import { CELLS_EDGES_CEILINGS } from '../../../src/io/test/tier/selection.js';
import { CLOCK_CEILING_FILE } from '../../../src/io/adapter-lints/clock.js';
import { FS_CEILING_FILE } from '../../../src/io/adapter-lints/fs.js';
import { LOAD_BEARING_CEILINGS } from '../../../src/logic/load/bearing.js';
import { STORE_BASELINE } from '../../../src/io/stores.js';
import { storeBaselineGrowth } from '../../../src/io/stores.js';

test('gate.ceiling-rows.owned-tables: the moveable ceiling tables are the five per-file source tables, each named by its owning module [L3,C7]', () => {
  assert.deepEqual(Object.keys(CEILING_ROW_TABLES).sort(), [LOAD_BEARING_CEILINGS, STORE_BASELINE, CLOCK_CEILING_FILE, FS_CEILING_FILE, CELLS_EDGES_CEILINGS].sort());
  assert.deepEqual(CEILING_ROW_TABLES[CLOCK_CEILING_FILE], { files: true, bare: true });
  assert.deepEqual(CEILING_ROW_TABLES[CELLS_EDGES_CEILINGS], { files: true });
  assert.deepEqual(CEILING_ROW_TABLES[STORE_BASELINE], {});
});

test('gate.ceiling-rows.staged: clause 3: the pre-commit cells-edges check reads the staged ceiling rows, and a store-homes row moved between files is not a rise [L3,C7]', () => {
  const check = STATIC_CHECKS.find(entry => entry.name === 'cells-edges');
  const file = 'apps/view/src/io/state.js';
  const source = "import { x } from '../../../../packages/config/index.js';\nexport const y = x;\n";
  const run = ceilingText => check.run({ root: '/nonexistent-root', sources: [{ file, source }],
    text: path => path === file ? source : path === CELLS_EDGES_CEILINGS ? ceilingText : '' });
  assert.deepEqual(run(JSON.stringify({ files: { [file]: { cells: 1, deep: 0 } }, cells: {}, packageApps: {} })), [], 'a row staged for the new file allows its one cell');
  assert.match(run(JSON.stringify({ files: {}, cells: {}, packageApps: {} })).join('\n'), /new cross-cell import of config exceeds the ratchet \(1 cells > 0\)/u, 'without the row the same import is refused');
  const main = { 'apps/view/src/io/serve.js': { 'resources.sqlite': 1 } };
  assert.deepEqual(storeBaselineGrowth({ 'apps/view/src/io/state.js': { 'resources.sqlite': 1 } }, main), [], 'a moved row keeps the total');
  assert.match(storeBaselineGrowth({ 'apps/view/src/io/serve.js': { 'resources.sqlite': 1 }, 'apps/view/src/io/state.js': { 'resources.sqlite': 1 } }, main)[0].text, /CD2_BASELINE_ROSE/u, 'a copied row raises the total');
});
