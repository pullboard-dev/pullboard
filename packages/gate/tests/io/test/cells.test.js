/** The cell-test rule admits the gate heavy door as the gate's second front door, and no other cell's heavy door or gate source file [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellTestProblems } from '../../../src/io/test/cells.js';
import { declaredReads } from '../../../src/io/test/cells.js';
import { sealedReport } from '../../../src/io/test/cells.js';
import { testCellsProblems } from '../../../src/io/test/cells.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const ORDER = new Map([['gate', 1], ['store', 2], ['board', 3]]);
const FILE = 'packages/board/tests/x.test.js';
const importing = target => `import { x } from '../../${target}';\n`;

test('gate.io-test-cells.heavy-door-admitted: clause 1: [C7] cellTestProblems reports no problem for a cell test importing packages/gate/heavy.js below it in plan order, and still reports a gate source file path and another cell heavy.js', () => {
  assert.deepEqual(cellTestProblems(FILE, importing('gate/heavy.js'), { order: ORDER }), []);
  assert.equal(cellTestProblems(FILE, importing('gate/src/io/test/cells.js'), { order: ORDER }).length, 1);
  assert.equal(cellTestProblems(FILE, importing('store/heavy.js'), { order: ORDER }).length, 1);
});

test('gate.io-test-cells.heavy-door-plan-order: clause 1: [C7] a cell test below gate in plan order importing packages/gate/heavy.js is still reported', () => {
  const below = new Map([['board', 1], ['gate', 2]]);
  assert.equal(cellTestProblems(FILE, importing('gate/heavy.js'), { order: below }).length, 1);
});

test('gate.io-test-path-read-sealing.a-cell-read-by-path-by: clause 1: [C7] a foreign declared reader counts once without unsealing the target, own-cell reads count zero, and the ratchet refuses growth while permitting a lower count', t => {
  const foreign = '/** @pullboard-test-input source-cell packages/gate */\n';
  const own = '/** @pullboard-test-input source-cell packages/gate */\n';
  const rows = [
    { file: 'packages/gate/tests/cells.test.js', kind: 'cell', cell: 'gate', root: false },
    { file: 'packages/board/tests/reader.test.js', kind: 'cell', cell: 'board', root: false },
  ];
  const cells = ['gate', 'board'];
  assert.deepEqual(declaredReads(foreign, cells), ['gate']);
  assert.deepEqual(declaredReads(`import { board } from '../../src/board.js';\n${foreign}`, cells), []);
  const foreignReport = sealedReport(rows, { cells, pathReaders: { 'packages/board/tests/reader.test.js': ['gate'] } }).find(row => row.cell === 'gate');
  assert.equal(foreignReport.sealed, true);
  assert.equal(foreignReport.pathReaders, 1);
  assert.equal(sealedReport(rows, { cells, pathReaders: { 'packages/gate/tests/cells.test.js': declaredReads(own, cells) } }).find(row => row.cell === 'gate').pathReaders, 0);

  const root = privateFixtureFiles('gate-cell-path-read-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['packages/gate/tests', 'packages/gate/src', 'packages/board/tests', 'packages/board/src']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'packages/gate/tests/cells.test.js'), "import { cellTestProblems } from '../src/cells.js';\n");
  writeFileSync(join(root, 'packages/gate/src/cells.js'), 'export const cells = true;\n');
  writeFileSync(join(root, 'packages/board/tests/reader.test.js'), `${foreign}import { board } from '../src/board.js';\n`);
  writeFileSync(join(root, 'packages/board/src/board.js'), 'export const board = true;\n');
  const listing = { journeys: {}, pureHelpers: [], leaves: [], findings: {}, rootTests: 0, sealed: ['gate'], splits: {}, pathReaders: { gate: 0 } };
  assert.match(testCellsProblems(root, { listing }).find(problem => problem.path === 'packages/gate').text, /1 tests outside cell gate read its files by path, over the ratchet of 0/u);
  listing.pathReaders.gate = 1;
  writeFileSync(join(root, 'packages/board/tests/reader.test.js'), `import { board } from '../src/board.js';\n${foreign}`);
  assert.deepEqual(testCellsProblems(root, { listing }), []);
});
