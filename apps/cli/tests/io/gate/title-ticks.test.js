/** With verify.titleTicks on, submit keeps an item's changed test titled "clause N:" as a gate file for a [test] clause naming no file, and the gate settle ticks the clause from it (#8880) [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { addItem } from '../../../../../packages/store/index.js';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';
import { clauseInspectionProblem } from '../../../../../packages/state/index.js';
import { gateClauseTickNotes } from '../../../../../packages/state/index.js';
import { configFromSource } from '../../../../../packages/config/index.js';
import { defaults } from '../../../../../packages/config/index.js';
import { fixtureCommittedGraph } from '../../fixtures/testkit.js';
import { gateTestFiles } from '../../../src/io/submit.js';
import { titleCases } from '../../../src/io/submit.js';

const HOUR = 3_600_000;
const NEW_TEST = 'apps/cli/journeys/bar/dry.test.js';
const CRITERION = '1. A test shows the dry run prints its checklist [test].';

/** A real repository whose item, claimed at its first commit, then adds a test titled for the bar's clause and one with no such title. */
function repo(t) {
  const graph = fixtureCommittedGraph('pullboard-title-ticks-');
  const { root } = graph;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('src/a.js', 'export const a = 1;\n');
  const base = graph.commit();
  graph.put(NEW_TEST, "test('clause 1: the dry run prints its checklist', () => {});\n");
  graph.put('apps/cli/journeys/barn/other.test.js', "test('unrelated case', () => {});\n");
  graph.commit();
  const item = { item_id: 9, item_owner: 'core-1', item_claim_head: base, item_criterion: CRITERION, item_frozen: CRITERION, item_brief: 'Files: src/a.js', item_check: '' };
  return { root, item };
}

/** A claimed board item carrying a bar that names no file. */
function boardItem(t) {
  const board = cellBoard(t, ':memory:');
  cellSeat(board, { lane: 'coordinator', path: '/fixture/main' });
  cellSeat(board, { lane: 'core', path: '/fixture/builder' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Title tick fixture', criterion: CRITERION, route: 'mid', brief: 'Files: src/a.js\nTest: the dry run prints its checklist', check: 'true' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 2 * HOUR, freeze: item => ({ text: item.item_criterion, digest: 'title' }) });
  return { board, id };
}

test('cli.io-gate-title-ticks.verify-titleticks-defaults-to-false-and-when: clause 1: verify.titleTicks defaults to false and, when on, a changed test titled for the clause is a gate file, so submit does not refuse CLAUSE_UNTICKED [C7]', t => {
  assert.equal(defaults().verify.titleTicks, false);
  assert.equal(configFromSource('{}').verify.titleTicks, false);
  assert.equal(configFromSource(JSON.stringify({ verify: { titleTicks: true } })).verify.titleTicks, true);
  assert.throws(() => configFromSource(JSON.stringify({ verify: { titleTicks: 'yes' } })), /titleTicks/u);
  const { root, item } = repo(t);
  const on = gateTestFiles(root, item, { titleTicks: true });
  assert.deepEqual([...on], [NEW_TEST], 'only the changed test holding a case titled for the clause, not the untitled one');
  assert.deepEqual([...gateTestFiles(root, item)], [], 'off by default: a changed test the bar does not quote is no gate file');
  const { board, id } = boardItem(t);
  const held = store.getItem(board, id);
  assert.equal(clauseInspectionProblem(held, store.itemThread(board, id), { gateFiles: on, head: 'b'.repeat(40), titleTicks: true, cases: titleCases(root, on) }), null);
  assert.equal(clauseInspectionProblem(held, store.itemThread(board, id), { gateFiles: gateTestFiles(root, item), head: 'b'.repeat(40) })?.code, 'CLAUSE_UNTICKED');
});

test('cli.io-gate-title-ticks.with-verify-titleticks-on-a-green-gate: clause 2: with verify.titleTicks on, a green gate run of the changed test records the clause tick note on the item [C7]', t => {
  const head = 'c'.repeat(40);
  const outcomes = [{ file: NEW_TEST, name: 'clause 1: the dry run prints its checklist', passed: true, skipped: false }];
  const notes = ({ board, id }, options) => {
    const texts = [];
    store.clauseInspectionNotes(board, id, { gateFiles: new Set([NEW_TEST]), outcomes, head, green: true, ...options }, text => {
      texts.push(text);
      store.appendFact(board, id, { agentId: 'core-1', kind: 'note', text });
    });
    return texts;
  };
  const on = boardItem(t);
  const recorded = notes(on, { titleTicks: true });
  assert.match(recorded[0], new RegExp(`^clause 1 \\[test\\]: gate run of ${NEW_TEST} green at ${head.slice(0, 12)}: 1 case passed`, 'u'));
  assert.ok(store.itemThread(on.board, on.id).some(row => String(row.fact_text ?? row.text ?? JSON.stringify(row)).includes(`gate run of ${NEW_TEST} green`)), 'the tick is on the item thread');
  const off = boardItem(t);
  assert.deepEqual(gateClauseTickNotes(store.getItem(off.board, off.id), store.itemThread(off.board, off.id), { gateFiles: new Set([NEW_TEST]), outcomes, head }), [], 'off ticks nothing');
});
