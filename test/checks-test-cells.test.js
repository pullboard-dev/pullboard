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
