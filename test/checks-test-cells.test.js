/** The test-cell check classifies every test as a cell test or a listed journey, ratchets its findings, and reports sealed cells [C7]. */
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import {
  classifyTests,
  readListing,
  testCellsProblems,
  testCellsReport,
  writeTestCells,
} from '../bin/checks/test-cells.js';

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture tree: cells a and b, one conforming cell test, one cell test that spawns the CLI, one unlisted root test. */
function fixture(extra = {}) {
  const inputs = privateFixtureFiles('test-cells-');
  made.push(inputs.root);
  const files = {
    'bin/checks/test-cells.json': JSON.stringify({ journeys: {}, pureHelpers: [], leaves: [], findings: {}, rootTests: 0, sealed: [] }),
    'packages/a/index.js': 'export const a = 1;\n',
    'packages/a/tests/good.test.js': "import { a } from '../index.js';\nimport test from 'node:test';\ntest('a', () => a);\n",
    'packages/b/index.js': 'export const b = 1;\n',
    'packages/b/tests/spawns.test.js': "import { spawnSync } from 'node:child_process';\nspawnSync('node', ['bin/pullboard.js', 'list']);\n",
    'test/unlisted.test.js': "import test from 'node:test';\ntest('x', () => {});\n",
    ...extra,
  };
  for (const [file, text] of Object.entries(files)) inputs.write(file, text);
  return inputs.root;
}

const FACTS = { cells: ['a', 'b'], deepImporters: {} };

test('clause 1: a conforming cell test passes, a cell test that spawns the CLI and an unlisted root test are findings naming their rule [C7]', () => {
  const root = fixture();
  const rows = classifyTests(root);
  const byFile = Object.fromEntries(rows.map(row => [row.file, row]));
  assert.equal(byFile['packages/a/tests/good.test.js'].kind, 'cell');
  assert.equal(byFile['packages/b/tests/spawns.test.js'].kind, 'finding');
  assert.match(byFile['packages/b/tests/spawns.test.js'].problems[0].text, /spawns no CLI/u);
  assert.equal(byFile['test/unlisted.test.js'].kind, 'finding');
  assert.match(byFile['test/unlisted.test.js'].problems[0].text, /unlisted root test/u);
  assert.deepEqual(Object.keys(testCellsReport(root, { facts: FACTS }).findings).sort(), ['packages/b/tests/spawns.test.js', 'test/unlisted.test.js']);
});

test('clause 1: a root test listed as a journey with a reason is not a finding, and a cell test importing another cell past a leaf door is [C7]', () => {
  const root = fixture({
    'bin/checks/test-cells.json': JSON.stringify({ journeys: { 'test/unlisted.test.js': 'drives the whole CLI' }, pureHelpers: [], leaves: [], findings: {}, rootTests: 1, sealed: [] }),
    'packages/a/tests/reaches.test.js': "import { b } from '../../b/index.js';\nexport const x = b;\n",
  });
  const rows = Object.fromEntries(classifyTests(root).map(row => [row.file, row]));
  assert.equal(rows['test/unlisted.test.js'].kind, 'journey');
  assert.equal(rows['packages/a/tests/reaches.test.js'].kind, 'finding');
  assert.match(rows['packages/a/tests/reaches.test.js'].problems[0].text, /outside its own cell a/u);
  const leafed = classifyTests(root, { listing: { ...readListing(root), leaves: ['b'] } }).find(row => row.file === 'packages/a/tests/reaches.test.js');
  assert.equal(leafed.kind, 'cell');
});

test('clause 2: the ratchet refuses a new finding and a higher root test count, and the write only lowers [C7]', () => {
  const root = fixture();
  assert.equal(writeTestCells(root, { initialize: true }).length, 0);
  const listing = readListing(root);
  assert.equal(listing.rootTests, 1);
  assert.deepEqual(Object.keys(listing.findings).sort(), ['packages/b/tests/spawns.test.js', 'test/unlisted.test.js']);
  assert.deepEqual(testCellsProblems(root, { facts: FACTS }), [], 'today passes');
  writeFileSync(join(root, 'test/another.test.js'), "import test from 'node:test';\ntest('y', () => {});\n");
  const problems = testCellsProblems(root, { facts: FACTS });
  assert.ok(problems.some(row => row.path === 'test/another.test.js' && /exceeds the ratchet/u.test(row.text)), 'the new unlisted test is named');
  assert.ok(problems.some(row => row.path === 'test' && /2 root test files exceed the ratchet of 1/u.test(row.text)), 'the root count rose');
  assert.match(writeTestCells(root)[0].text, /only lowers/u);
  assert.equal(readListing(root).rootTests, 1, 'nothing was recorded');
});

test('clause 3: a cell with only conforming tests reports sealed, one with a finding or a deep importer does not, and a lost seal is refused [C7]', () => {
  const root = fixture();
  const cells = Object.fromEntries(testCellsReport(root, { facts: FACTS }).cells.map(row => [row.cell, row]));
  assert.equal(cells.a.sealed, true);
  assert.equal(cells.b.sealed, false);
  assert.equal(cells.b.findings, 1);
  const deep = Object.fromEntries(testCellsReport(root, { facts: { cells: ['a', 'b'], deepImporters: { a: 1 } } }).cells.map(row => [row.cell, row]));
  assert.equal(deep.a.sealed, false);
  assert.equal(deep.a.deepImporters, 1);
  const listing = { ...readListing(root), sealed: ['a'], rootTests: 1, findings: { 'packages/b/tests/spawns.test.js': 'x', 'test/unlisted.test.js': 'x' } };
  assert.deepEqual(testCellsProblems(root, { facts: FACTS, listing }), []);
  const lost = testCellsProblems(root, { facts: { cells: ['a', 'b'], deepImporters: { a: 1 } }, listing });
  assert.match(lost[0].text, /cell a is no longer sealed/u);
  assert.ok(readFileSync(join(root, 'bin/checks/test-cells.json'), 'utf8').includes('journeys'));
});

test('clause 1: a cell test that imports front doors of cells below it is the component tier; one above it or past a front door is a finding [C7,V23]', () => {
  const root = fixture({
    'bin/cells-plan.json': JSON.stringify({ cells: [{ order: 1, name: 'b' }, { order: 2, name: 'a' }] }),
    'packages/b/src/inner.js': 'export const inner = 1;\n',
    'packages/a/tests/component.test.js': "import { a } from '../index.js';\nimport { b } from '../../b/index.js';\nexport const x = [a, b];\n",
    'packages/a/tests/deep.test.js': "import { inner } from '../../b/src/inner.js';\nexport const x = inner;\n",
    'packages/b/tests/upward.test.js': "import { a } from '../../a/index.js';\nexport const x = a;\n",
  });
  const rows = Object.fromEntries(classifyTests(root).map(row => [row.file, row]));
  assert.equal(rows['packages/a/tests/component.test.js'].kind, 'cell');
  assert.equal(rows['packages/a/tests/component.test.js'].tier, 'component');
  assert.equal(rows['packages/a/tests/good.test.js'].tier, 'unit');
  assert.equal(rows['packages/a/tests/deep.test.js'].kind, 'finding', 'past a front door is still a finding');
  assert.match(rows['packages/a/tests/deep.test.js'].problems[0].text, /imports packages\/b\/src\/inner\.js/u);
  assert.equal(rows['packages/b/tests/upward.test.js'].kind, 'finding', 'a cell above is still a finding');
});

test('clause 2: a test in apps/<name>/tests importing its own app is its own cell, not a finding [C7]', () => {
  const root = fixture({
    'apps/r/index.js': 'export const r = 1;\n',
    'apps/r/tests/own.test.js': "import { r } from '../index.js';\nexport const x = r;\n",
  });
  const row = classifyTests(root).find(entry => entry.file === 'apps/r/tests/own.test.js');
  assert.equal(row.cell, 'apps/r');
  assert.deepEqual([row.kind, row.problems], ['cell', []]);
});

test('clause 3: a listed pure helper may be imported by a cell test, and a listed helper that reaches product code is refused [C7]', () => {
  const root = fixture({
    'test/pure.js': "import { tmpdir } from 'node:os';\nexport const where = tmpdir;\n",
    'test/impure.js': "import { a } from '../packages/a/index.js';\nexport const x = a;\n",
    'packages/a/tests/helped.test.js': "import { where } from '../../../test/pure.js';\nexport const x = where;\n",
  });
  const listing = { ...readListing(root), pureHelpers: { 'test/pure.js': 'imports only node built-ins', 'test/impure.js': 'claimed pure' } };
  const row = classifyTests(root, { listing }).find(entry => entry.file === 'packages/a/tests/helped.test.js');
  assert.equal(row.kind, 'cell');
  const problems = testCellsProblems(root, { listing, facts: FACTS }).map(problem => `${problem.path}: ${problem.text}`);
  assert.ok(problems.includes('test/impure.js: listed as a pure helper but imports packages/a/index.js, which is not a listed pure helper'), problems.join('\n'));
  assert.ok(!problems.some(text => text.startsWith('test/pure.js')), 'a pure helper is not refused');
});
