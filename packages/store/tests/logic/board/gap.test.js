/** An uncovered reviewer failure files a selector repair without rejecting the submitted builder [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';

const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), TRUNK = 'c'.repeat(40);

/** Create a submitted item with a complete, narrow selection and two independent core seats. */
function fixture(t) {
  const board = fixtureBoard(t);
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1' });
  store.register(board, { id: 'core-2', lane: 'core', path: '/fixture/core-2' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Selector gap fixture', criterion: 'The submitted work meets its frozen bar.' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: JSON.stringify({ criterion: 'The submitted work meets its frozen bar.', check: '', rows: [] }), digest: 'f'.repeat(64) }) });
  store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, gateGreen: true, policyCommit: TRUNK,
    submissionProof: { version: 1, files: ['test/selected.test.js'], full: false, deferred: false, reason: 'affected tests' } });
  return { board, id };
}

/** Store a native-shaped failing verdict receipt in the board event stream for focused routing tests. */
function failedReview(board, id, { file = 'test/unselected.test.js', name = 'unselected case' } = {}) {
  const receiptId = `review-${name.replaceAll(' ', '-')}`;
  const failure = { file, name };
  store.logEvent(board, 'core-2', 'proof-run', id, { receipt: { id: receiptId, kind: 'verdict', item: id, commit: COMMIT,
    tree: TREE, frozenDigest: 'f'.repeat(64), seat: 'core-2', sourceClean: true, exitCode: 1,
    counts: { passed: 0, failed: 1, skipped: 0 }, failures: [failure],
    testOutcomes: [{ ...failure, passed: false, skipped: false }] } });
  return receiptId;
}

test('store.logic-board-gap.an-uncovered-failing-review-case-records: an uncovered failing review case records SELECTOR_GAP and leaves the builder submitted [C7]', t => {
  const { board, id } = fixture(t);
  const receiptId = failedReview(board, id);
  const review = { commit: COMMIT, head: COMMIT, trunk: TRUNK, paths: [] };
  const recorded = store.recordSelectorGap(board, { agentId: 'core-2', itemId: id, receiptId, review });
  assert.equal(recorded.decision, 'SELECTOR_GAP');
  assert.equal(recorded.filed, true);
  assert.equal(store.getItem(board, id).item_status, 'submitted', 'the builder item stays submitted for review');
  assert.equal(store.getItem(board, recorded.item).item_lane, 'core');
  const verdict = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='selector-gap'").get(id);
  assert.equal(JSON.parse(verdict.event_detail).decision, 'SELECTOR_GAP');
  assert.equal(JSON.parse(verdict.event_detail).repairItem, recorded.item);
  assert.deepEqual(store.recordSelectorGap(board, { agentId: 'core-2', itemId: id, receiptId, review }),
    { decision: 'SELECTOR_GAP', item: recorded.item, filed: false }, 'repeated reviews reuse the same repair item');
});

test('store.logic-board-gap.a-selected-failure-follows-the-ordinary: a selected failure follows the ordinary reject path [C7]', t => {
  const { board, id } = fixture(t);
  const review = { commit: COMMIT, head: COMMIT, trunk: TRUNK, paths: [] };
  const selectedReceipt = failedReview(board, id, { file: 'test/selected.test.js', name: 'selected case' });
  assert.equal(store.selectorGapCandidate(board, { agentId: 'core-2', itemId: id, receiptId: selectedReceipt, review }), null,
    'a test in the gate selection cannot become a selector gap');
  store.verify(board, id, { agentId: 'core-2', decision: 'REJECT', reason: 'TEST_FAILURE',
    note: 'The selected test case failed.', clause: 'The submitted work meets its frozen bar.',
    head: COMMIT, digest: 'f'.repeat(64), policy: 'any', review });
  assert.notEqual(store.getItem(board, id).item_status, 'submitted', 'the ordinary rejection reopens selected failing work');
});

test('store.logic-board-gap.a-frozen-criterion-failure-is-not: a frozen criterion failure is not recast as a selector gap [C7]', t => {
  const { board, id } = fixture(t);
  const review = { commit: COMMIT, head: COMMIT, trunk: TRUNK, paths: [] };
  store.logEvent(board, 'core-1', 'proof-run', id, { receipt: { id: 'criterion-pass', kind: 'submit', item: id, commit: COMMIT,
    tree: TREE, frozenDigest: 'f'.repeat(64), seat: 'core-1', sourceClean: true, exitCode: 0, submitPhase: 'criterion',
    counts: { passed: 1, failed: 0, skipped: 0 }, failures: [],
    testOutcomes: [{ file: 'test/required.test.js', name: 'required clause', passed: true, skipped: false }] } });
  const criterionReceipt = failedReview(board, id, { file: 'test/required.test.js', name: 'required clause' });
  assert.equal(store.selectorGapCandidate(board, { agentId: 'core-2', itemId: id, receiptId: criterionReceipt, review }), null,
    'a frozen criterion case is required evidence even outside proof-phase selection');
  assert.equal(store.getItem(board, id).item_status, 'submitted', 'classification did not preempt the ordinary verdict');
  store.verify(board, id, { agentId: 'core-2', decision: 'REJECT', reason: 'TEST_FAILURE',
    note: 'The required frozen criterion case failed.', clause: 'The submitted work meets its frozen bar.',
    head: COMMIT, digest: 'f'.repeat(64), policy: 'any', review });
  assert.notEqual(store.getItem(board, id).item_status, 'submitted', 'an uncovered required failure still follows the ordinary reject path');
});
