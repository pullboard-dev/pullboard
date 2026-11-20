/** A landed, submitted sprint item is offered for review and takes its verdict; steady and strict items that landed still refuse one [V2,M1,#12180]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { heartbeatSeat } from '../../../index.js';

// fixture-subject: addItem (a store unit test of the review pick and verify over a hand-built submitted item)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), LANDED = 'c'.repeat(40);
const REVIEW = { policy: 'any', familyPolicy: 'off' };

/** A submitted item frozen under `pace`, built by core-1, with core-2 live to review it. */
function submitted(t, pace) {
  const board = fixtureBoard(t);
  for (const id of ['coordinator', 'core-1', 'core-2']) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, model: SYNTHETIC_MODEL });
    heartbeatSeat(board, id);
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: `Sprint verdict fixture (${pace})` });
  const freeze = () => ({ text: JSON.stringify(pace === 'steady' ? {} : { pace }), digest: `synthetic-sprint-verdict-${pace}` });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze });
  store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  assert.equal(store.itemPace(store.getItem(board, id)), pace, `the claim froze the ${pace} pace`);
  return { board, id };
}

/** Accept the item as core-2 with the sealed review the CLI records, so the verify table and its not-merged guard decide. */
function accept(board, id) {
  const item = store.getItem(board, id);
  return store.verify(board, id, { agentId: 'core-2', decision: 'ACCEPT', head: item.item_commit, digest: item.item_frozen_digest,
    note: 'Synthetic sprint verdict fixture accept.', ...REVIEW, review: { commit: item.item_commit, head: item.item_commit, trunk: LANDED, paths: [] } });
}

test('store.io-board-sprint-verdict.landed-sprint-takes-verdict: clause 1: a submitted sprint item the lander merged is offered by the review pick and an accept records verified with the item still landed [V2,M1,#12180]', t => {
  const { board, id } = submitted(t, 'sprint');
  store.merged(board, id, { agentId: 'coordinator', commit: LANDED });
  const landed = store.getItem(board, id);
  assert.deepEqual([landed.item_status, landed.item_merged_commit], ['submitted', LANDED], 'sprint lands submitted work before its verdict');
  const picked = store.reserveNextReview(board, { agentId: 'core-2', lane: 'core', leaseMs: 3_600_000, ...REVIEW });
  assert.equal(picked.item?.item_id, id, 'the review pick offers the landed sprint item');
  assert.equal(accept(board, id).decision, 'ACCEPT');
  const verified = store.getItem(board, id);
  assert.deepEqual([verified.item_status, verified.item_merged_commit], ['verified', LANDED], 'the accept records verified and keeps the landing');
});

test('store.io-board-sprint-verdict.steady-strict-landed-refused: clause 1: a steady or strict submitted item that already landed still refuses a verdict ALREADY_MERGED [V2,M1,#12180]', t => {
  for (const pace of ['steady', 'strict']) {
    const { board, id } = submitted(t, pace);
    // Neither pace lands submitted work, so the landing is written straight onto the row to reach the guard.
    board.db.prepare('UPDATE item SET item_merged_commit = ? WHERE item_id = ?').run(LANDED, id);
    assert.throws(() => accept(board, id), error => error.code === 'ALREADY_MERGED', `${pace}: a landed item takes no verdict`);
    assert.equal(store.getItem(board, id).item_status, 'submitted', `${pace}: the item is unchanged`);
  }
});
