/** With verify.folderTicks on, submit keeps an item's changed test under a folder its bar quotes as a gate file, and the gate settle ticks the clause from it (#8847) [C7]. */
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

const HOUR = 3_600_000;
const NEW_TEST = 'apps/cli/journeys/bar/dry.test.js';
const CRITERION = '1. A new test in apps/cli/journeys/bar proves the dry run prints its checklist [test].';

/** A real repository whose item, claimed at its first commit, then adds a test under the folder the bar quotes and one elsewhere. */
function repo(t) {
  const graph = fixtureCommittedGraph('pullboard-folder-ticks-');
  const { root } = graph;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('src/a.js', 'export const a = 1;\n');
  const base = graph.commit();
  graph.put(NEW_TEST, "test('clause 1: the dry run prints its checklist', () => {});\n");
  graph.put('apps/cli/journeys/barn/other.test.js', '\n');
  graph.commit();
  const item = { item_id: 9, item_owner: 'core-1', item_claim_head: base, item_criterion: CRITERION, item_frozen: CRITERION, item_brief: 'Files: src/a.js', item_check: '' };
  return { root, item };
}

/** A claimed board item carrying the folder-named bar. */
function boardItem(t) {
  const board = cellBoard(t, ':memory:');
  cellSeat(board, { lane: 'coordinator', path: '/fixture/main' });
  cellSeat(board, { lane: 'core', path: '/fixture/builder' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Folder tick fixture', criterion: CRITERION, route: 'mid', brief: 'Files: src/a.js\nTest: the dry run prints its checklist', check: 'true' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 2 * HOUR, freeze: item => ({ text: item.item_criterion, digest: 'folder' }) });
  return { board, id };
}

test('cli.io-gate-folder-ticks.verify-folderticks-defaults-to-false-and-when: clause 1: verify.folderTicks defaults to false and, when on, a changed test under the quoted folder is a gate file, so submit does not refuse CLAUSE_UNTICKED [C7]', t => {
  assert.equal(defaults().verify.folderTicks, false);
  assert.equal(configFromSource('{}').verify.folderTicks, false);
  assert.equal(configFromSource(JSON.stringify({ verify: { folderTicks: true } })).verify.folderTicks, true);
  assert.throws(() => configFromSource(JSON.stringify({ verify: { folderTicks: 'yes' } })), /folderTicks/u);
  const { root, item } = repo(t);
  const on = gateTestFiles(root, item, { folderTicks: true });
  assert.deepEqual([...on], [NEW_TEST], 'only the test under the quoted folder, not the sibling folder');
  assert.deepEqual([...gateTestFiles(root, item)], [], 'off by default: a changed test the bar does not quote is no gate file');
  const { board, id } = boardItem(t);
  const held = store.getItem(board, id);
  assert.equal(clauseInspectionProblem(held, store.itemThread(board, id), { gateFiles: on, head: 'b'.repeat(40), folderTicks: true }), null);
  assert.equal(clauseInspectionProblem(held, store.itemThread(board, id), { gateFiles: gateTestFiles(root, item), head: 'b'.repeat(40) })?.code, 'CLAUSE_UNTICKED');
});

test('cli.io-gate-folder-ticks.with-verify-folderticks-on-a-green-gate: clause 2: with verify.folderTicks on, a green gate run of the changed test records the clause tick note on the item [C7]', t => {
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
  const recorded = notes(on, { folderTicks: true });
  assert.match(recorded[0], new RegExp(`^clause 1 \\[test\\]: gate run of ${NEW_TEST} green at ${head.slice(0, 12)}: 1 case passed`, 'u'));
  assert.ok(store.itemThread(on.board, on.id).some(row => String(row.fact_text ?? row.text ?? JSON.stringify(row)).includes(`gate run of ${NEW_TEST} green`)), 'the tick is on the item thread');
  const off = boardItem(t);
  assert.deepEqual(gateClauseTickNotes(store.getItem(off.board, off.id), store.itemThread(off.board, off.id), { gateFiles: new Set([NEW_TEST]), outcomes, head }), [], 'off ticks nothing');
});
