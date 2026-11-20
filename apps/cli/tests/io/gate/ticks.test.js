/** A [test] clause naming a test file the gate runs is ticked by the gate, not refused CLAUSE_UNTICKED [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';
import { clauseInspectionProblem } from '../../../../../packages/state/index.js';
import { clauseInspectionSummary } from '../../../../../packages/state/index.js';
import { selectedGateFiles } from '../../../src/io/submit.js';

const HOUR = 3_600_000;

/** A claimed item whose criterion and brief are the given text. */
function fixture(t, criterion, brief = 'Files: src/a.js\nTest: one named case') {
  const board = cellBoard(t, ':memory:');
  cellSeat(board, { lane: 'coordinator', path: '/fixture/main' });
  cellSeat(board, { lane: 'core', path: '/fixture/builder' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Gate tick fixture', criterion, route: 'mid', brief, check: 'true' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 2 * HOUR, freeze: item => ({ text: item.item_criterion, digest: 'ticks' }) });
  return { board, id };
}

/** The clause problem for a fixture item under the given gate selection. */
const problem = ({ board, id }, options) => clauseInspectionProblem(store.getItem(board, id), store.itemThread(board, id), options);

test('cli.io-gate-ticks.a-test-clause-naming-a-file-the: clause 1: a [test] clause naming a file the gate runs is not refused unticked, and the summary says the gate ticked it [C7]', t => {
  const f = fixture(t, '1. test/page.test.js passes [test]');
  assert.match(problem(f).message, /clause 1 .*has no evidence/u);
  assert.equal(problem(f, { gateFiles: new Set(['test/page.test.js']) }), null);
  assert.equal(problem(f, { greenFiles: new Set(['test/page.test.js']) }), null);
  const summary = clauseInspectionSummary(store.getItem(f.board, f.id), store.itemThread(f.board, f.id), { gateFiles: new Set(['test/page.test.js']) });
  assert.match(summary, /1\. .* -> test: ticked by the gate run of test\/page\.test\.js/u);
  const briefed = fixture(t, '1. the page renders [test]', 'Files: web/page.html\nTest:\n- test/page.test.js');
  assert.equal(problem(briefed, { gateFiles: new Set(['test/page.test.js']) }), null, 'the brief names the test file');
});

test('cli.io-gate-ticks.a-test-clause-naming-no-test-the: clause 2: a [test] clause naming no test the gate runs is still refused CLAUSE_UNTICKED [C7]', t => {
  const f = fixture(t, '1. test/page.test.js passes [test]');
  const refused = problem(f, { gateFiles: new Set(['test/other.test.js']) });
  assert.equal(refused.code, 'CLAUSE_UNTICKED');
  assert.match(refused.message, /tick each with: pullboard fact/u);
  const command = fixture(t, '1. test/page.test.js prints 3 [command]');
  assert.equal(problem(command, { gateFiles: new Set(['test/page.test.js']) }).code, 'CLAUSE_UNTICKED', 'only a [test] clause is ticked by the gate');
});

test('cli.io-gate-ticks.a-test-clause-naming-a-journey-test: clause 2: a [test] clause naming a journey test the gate defers to landing is still refused CLAUSE_UNTICKED [C7]', t => {
  const f = fixture(t, '1. test/journey.test.js passes [test]');
  const ran = selectedGateFiles(['test/page.test.js', 'test/journey.test.js', 'src/a.js'], ['test/page.test.js']);
  assert.deepEqual([...ran], ['test/page.test.js'], 'only a test file in the tier plan counts as run');
  assert.equal(problem(f, { gateFiles: ran }).code, 'CLAUSE_UNTICKED');
  assert.deepEqual([...selectedGateFiles(['test/a.test.js', 'x.js'], null)], ['test/a.test.js'], 'without a tier plan every test file counts');
});
