/** With runs_store on, verify and withdraw end the review lease in the run lease columns and write no job rows; off, leases behave as today [B2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { writeBoardMeta } from '../../../src/io/board/meta.js';
import { heartbeatSeat } from '../../../index.js';

// fixture-subject: addItem (a store unit test of verify and withdraw over a hand-built submitted item)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const freeze = () => ({ text: '{}', digest: 'synthetic-review-lease-verdict-bar' });
const REVIEW = { policy: 'any', familyPolicy: 'off' };

/** A submitted item built by core-1 and reserved for core-2, with the runs_store flag as asked. */
function fixture(t, runsStore) {
  const board = fixtureBoard(t);
  for (const id of ['coordinator', 'core-1', 'core-2']) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, model: SYNTHETIC_MODEL });
    heartbeatSeat(board, id);
  }
  if (runsStore) writeBoardMeta(board.db, 'runs_store', '1');
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review lease verdict fixture' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze });
  store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  store.reserveReview(board, id, { agentId: 'core-2', leaseMs: 60_000, ...REVIEW });
  return { board, id, run: () => board.db.prepare('SELECT * FROM run WHERE run_job = ?').get(`review:${id}`),
    job: () => board.db.prepare('SELECT job_lease_owner AS owner FROM job WHERE job_id = ?').get(`review:${id}`),
    jobRows: () => board.db.prepare('SELECT (SELECT COUNT(*) FROM job) AS jobs, (SELECT COUNT(*) FROM job_step) AS steps').get() };
}

/** Accept the fixture item as its reviewer. */
function accept(f) {
  const item = store.getItem(f.board, f.id);
  return store.verify(f.board, f.id, { agentId: 'core-2', decision: 'ACCEPT', head: item.item_commit, digest: item.item_frozen_digest,
    note: 'Synthetic review lease verdict fixture accept.', ...REVIEW });
}

test('store.io-board-review-lease-verdict.with-runs-store-on-verify-ends: clause 1: with runs_store on, verify ends the review lease in the run lease columns and writes no job row [B2]', t => {
  const f = fixture(t, true);
  assert.equal(f.run().run_lease_owner, 'core-2', 'the reservation holds the lease before the verdict');
  const before = f.jobRows();
  assert.equal(accept(f).decision, 'ACCEPT');
  const row = f.run();
  assert.equal(row.run_lease_owner, null);
  assert.equal(row.run_lease_until, 0);
  assert.equal(row.run_state, 'done');
  assert.deepEqual(f.jobRows(), before);
});

test('store.io-board-review-lease-verdict.with-runs-store-on-withdraw-ends: clause 2: with runs_store on, withdraw ends the review lease in the run lease columns and writes no job row [B2]', t => {
  const f = fixture(t, true);
  const before = f.jobRows();
  store.withdraw(f.board, f.id, { agentId: 'coordinator', reason: 'duplicate of another item' });
  const row = f.run();
  assert.equal(row.run_lease_owner, null);
  assert.equal(row.run_lease_until, 0);
  assert.equal(row.run_state, 'done');
  assert.deepEqual(f.jobRows(), before);
});

test('store.io-board-review-lease-verdict.with-runs-store-off-review-leases: clause 3: with runs_store off, review leases behave exactly as today on a job row [B2]', t => {
  const verified = fixture(t, false);
  assert.equal(verified.run(), undefined);
  assert.equal(verified.job().owner, 'core-2');
  accept(verified);
  assert.equal(verified.run(), undefined, 'no run row is written with the flag off');
  assert.equal(verified.job().owner, null, 'verify ends the job lease');
  const withdrawn = fixture(t, false);
  store.withdraw(withdrawn.board, withdrawn.id, { agentId: 'coordinator', reason: 'duplicate of another item' });
  assert.equal(withdrawn.run(), undefined);
  assert.equal(withdrawn.job().owner, null, 'withdraw ends the job lease');
});
