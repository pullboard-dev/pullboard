/** Deterministic test placement follows real input edges without hiding uncertainty [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTestFiles } from '../bin/cells-test-placement.js';
import { placeTests } from '../bin/cells-test-placement.js';
import { runFixtureChild } from './fixture-child.js';

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

test('clause 3: the fixture report shows a cell, a journey and an unknown reason, with per-cell counts [C7,CD64]', () => {
  const lines = placeTests([...files.keys()], inventory, plan);
  assert.deepEqual(lines, [
    'docs/guide.test.js\tcell store',
    'test/asset.txt\tunknown not a JavaScript module',
    'test/helper.js\tcell kernel',
    'test/journey.test.js\tjourney kernel,store',
    'test/missing.test.js\tunknown computed import',
    'test/one.test.js\tcell kernel',
    'files for cell kernel: 2',
    'files for cell store: 1',
    'journeys: 1',
    'unknown: 2',
    'total: 6',
  ]);
});

test('clause 1: node bin/cells-plan.js --place-tests prints every tracked test file and docs check with its home; clause 2: a repeated run prints identical output [C7,CD64]', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const run = () => runFixtureChild(process.execPath, ['bin/cells-plan.js', '--place-tests'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const first = run();
  assert.equal(first.failure, null, first.context);
  const second = run();
  assert.equal(second.failure, null, second.context);
  assert.equal(second.stdout, first.stdout, 'a repeated --place-tests run prints identical output');
  const tracked = runFixtureChild('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout.split('\0').filter(Boolean);
  const expected = tracked.filter(path => path.startsWith('test/') || /^docs\/.*\.test\.[cm]?js$/u.test(path)).sort();
  const lines = first.stdout.trimEnd().split('\n');
  const rows = lines.filter(line => line.includes('\t'));
  assert.deepEqual(rows.map(line => line.split('\t')[0]), expected);
  assert.ok(rows.every(line => /\t(cell \S+|journey \S+,\S+|unknown .+)$/u.test(line)), 'every file names a cell, a journey or an unknown reason');
  const counts = lines.filter(line => line.startsWith('files for cell '));
  const { readPlan } = await import('../bin/cells-plan.js');
  assert.equal(counts.length, readPlan(root).cells.length, 'every plan cell reports how many test files it gets');
  assert.equal(lines.at(-1), `total: ${expected.length}`);
});
