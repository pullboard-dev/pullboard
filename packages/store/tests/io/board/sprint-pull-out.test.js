/** A reject of landed sprint work writes one pull_out, so its landing reads pulling for the pull-out job; a steady reject writes none [M2,R3,#12181]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { heartbeatSeat } from '../../../index.js';

// fixture-subject: addItem (a store unit test of the verify writer over a hand-built submitted item)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), LANDED = 'c'.repeat(40);
const REVIEW = { policy: 'any', familyPolicy: 'off' };
const CLAUSE = 'the fixture keeps its landed behavior';

/** A submitted item frozen under `pace` with one clause, built by core-1, with core-2 live to review it. */
function submitted(t, pace) {
  const board = fixtureBoard(t);
  for (const id of ['coordinator', 'core-1', 'core-2']) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, model: SYNTHETIC_MODEL });
    heartbeatSeat(board, id);
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: `Sprint pull-out fixture (${pace})`, criterion: `1. ${CLAUSE} [test]` });
  const frozen = { criterion: `1. ${CLAUSE} [test]`, ...(pace === 'steady' ? {} : { pace }) };
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: JSON.stringify(frozen), digest: `synthetic-sprint-pull-out-${pace}` }) });
  store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  return { board, id };
}

/** Reject the item as core-2 with the sealed review the CLI records. */
function reject(board, id) {
  const item = store.getItem(board, id);
  return store.verify(board, id, { agentId: 'core-2', decision: 'REJECT', reason: 'TEST_FAILURE', clause: CLAUSE, head: item.item_commit, digest: item.item_frozen_digest,
    note: 'Synthetic sprint pull-out fixture reject.', ...REVIEW, review: { commit: item.item_commit, head: item.item_commit, trunk: LANDED, paths: [] } });
}

const pullOuts = (board, id) => board.db.prepare("SELECT event_by by, event_detail d FROM event WHERE item_id=? AND event_kind='pull_out'").all(id)
  .map(row => ({ by: row.by, detail: JSON.parse(row.d) }));

test('store.io-board-sprint-pull-out.landed-sprint-reject-pulls-out: clause 1: a reject of a submitted sprint item the lander merged writes one pull_out naming its commits and builder, and its landing reads pulling [M2,R3,#12181]', t => {
  const { board, id } = submitted(t, 'sprint');
  store.merged(board, id, { agentId: 'coordinator', commit: LANDED });
  assert.equal(reject(board, id).decision, 'REJECT');
  const written = pullOuts(board, id);
  assert.equal(written.length, 1, 'one pull_out');
  assert.equal(written[0].by, 'coordinator');
  assert.deepEqual([written[0].detail.commit, written[0].detail.mergedCommit, written[0].detail.builder, written[0].detail.reason], [COMMIT, LANDED, 'core-1', 'TEST_FAILURE']);
  assert.deepEqual(store.pullingLanding(board, id), { mergedCommit: LANDED }, 'its landing reads pulling, so the pull-out job takes it');
  assert.equal(store.getItem(board, id).item_status, 'open', 'the item is open again for its builder');
});

test('store.io-board-sprint-pull-out.unlanded-and-steady-write-none: clause 2: a sprint reject before landing and a steady reject write no pull_out and leave no landing pulling [M2,R3,#12181]', t => {
  for (const pace of ['sprint', 'steady']) {
    const { board, id } = submitted(t, pace);
    assert.equal(reject(board, id).decision, 'REJECT', `${pace}: the reject records`);
    assert.equal(pullOuts(board, id).length, 0, `${pace}: no pull_out`);
    assert.equal(store.pullingLanding(board, id), null, `${pace}: nothing is pulling`);
  }
});
