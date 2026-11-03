/** Deterministic test placement follows real input edges without hiding uncertainty [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTestFiles } from '../bin/cells-test-placement.js';

const plan = { cells: [
  { name: 'kernel', root: 'packages/kernel', paths: [['src/a.js', 'packages/kernel/a.js']] },
  { name: 'store', root: 'packages/store', paths: [['src/b.js', 'packages/store/b.js']] },
] };
const files = new Map(['test/one.test.js', 'test/helper.js', 'test/journey.test.js', 'test/missing.test.js',
  'test/asset.txt', 'docs/guide.test.js', 'src/a.js', 'src/b.js'].map(file => [file, Buffer.from('')]));
const edges = new Map([
  ['test/one.test.js', [{ target: 'test/helper.js' }]], ['test/helper.js', [{ target: 'src/a.js' }]],
  ['test/journey.test.js', [{ target: 'src/b.js' }, { target: 'src/a.js' }]],
  ['docs/guide.test.js', [{ target: 'src/b.js' }]], ['test/missing.test.js', []],
]);
const inventory = { files, edges, unknown: [{ file: 'test/missing.test.js', reason: 'computed import' }] };

test('every tracked test and docs check is classified deterministically [C7,CD64]', () => {
  const tracked = [...files.keys()].reverse();
  const rows = classifyTestFiles(tracked, inventory, plan);
  assert.deepEqual(rows, classifyTestFiles([...tracked].reverse(), inventory, plan));
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.find(row => row.file === 'test/one.test.js'), { file: 'test/one.test.js', kind: 'cell', cell: 'kernel' });
  assert.deepEqual(rows.find(row => row.file === 'test/journey.test.js'), { file: 'test/journey.test.js', kind: 'journey', cells: ['kernel', 'store'] });
  assert.deepEqual(rows.find(row => row.file === 'test/missing.test.js'), { file: 'test/missing.test.js', kind: 'undecidable', reason: 'computed import', cells: [] });
  assert.equal(rows.find(row => row.file === 'test/asset.txt').kind, 'undecidable');
  assert.equal(rows.find(row => row.file === 'docs/guide.test.js').cell, 'store');
});

test('the repository census accounts for every tracked test and docs check [C7,CD64]', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { readPlan } = await import('../bin/cells-plan.js');
  const { cellInventory } = await import('../packages/codemap/index.js');
  const { importsIn, commonJsIn } = await import('../packages/gate/index.js');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const inventory = cellInventory(root, { importsIn, commonJsIn });
  const rows = classifyTestFiles(tracked, inventory, readPlan(root));
  const expected = tracked.filter(file => file.startsWith('test/') || /^docs\/.*\.test\.[cm]?js$/u.test(file));
  assert.equal(rows.length, expected.length);
  assert.deepEqual(rows.map(row => row.file), [...expected].sort());
  assert.ok(rows.every(row => row.kind === 'cell' ? !!row.cell : row.kind === 'journey' ? row.cells.length > 1 : !!row.reason));
});
