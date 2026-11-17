/** With runs_store on, reserve and reopen hold the review lease in the run lease columns and write no job rows [B2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { writeBoardMeta } from '../../../src/io/board/meta.js';
import { heartbeatSeat } from '../../../index.js';

// fixture-subject: addItem (a store unit test of reserve and reopen over a hand-built submitted item)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const freeze = () => ({ text: '{}', digest: 'synthetic-review-lease-bar' });
const REVIEW = { policy: 'any', familyPolicy: 'off' };

/** A submitted item built by core-1 with reviewer seats core-2 and core-3, and the runs_store flag as asked. */
function fixture(t, runsStore) {
  const board = fixtureBoard(t);
  for (const id of ['coordinator', 'core-1', 'core-2', 'core-3']) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, model: SYNTHETIC_MODEL });
    heartbeatSeat(board, id);
  }
  if (runsStore) writeBoardMeta(board.db, 'runs_store', '1');
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review lease fixture' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze });
  store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  return { board, id, run: () => board.db.prepare('SELECT * FROM run WHERE run_job = ?').get(`review:${id}`),
    jobRows: () => board.db.prepare('SELECT (SELECT COUNT(*) FROM job) AS jobs, (SELECT COUNT(*) FROM job_step) AS steps').get() };
}

test('clause 1: with runs_store on, a review reservation made by reserve holds its lease in the run lease columns [B2]', t => {
  const f = fixture(t, true);
  store.reserveReview(f.board, f.id, { agentId: 'core-2', leaseMs: 60_000, ...REVIEW });
  const row = f.run();
  assert.equal(row.run_kind, 'review');
  assert.equal(row.run_lease_owner, 'core-2');
  assert.ok(row.run_lease_until > Date.now() - 1000, 'the lease runs out in the future');
  assert.equal(store.getItem(f.board, f.id).item_review_by, 'core-2');
});

test('clause 2: with runs_store on, reopen releases the lease in the run lease columns [B2]', t => {
  const f = fixture(t, true);
  store.reserveReview(f.board, f.id, { agentId: 'core-2', leaseMs: 60_000, ...REVIEW });
  store.reopen(f.board, f.id, { agentId: 'coordinator', note: 'the criterion needs correction' });
  const row = f.run();
  assert.equal(row.run_lease_owner, null);
  assert.equal(row.run_lease_until, 0);
  assert.equal(row.run_state, 'done');
});

test('clause 3: with runs_store on, neither move writes a job or job_step row [B2]', t => {
  const f = fixture(t, true);
  const before = f.jobRows();
  store.reserveReview(f.board, f.id, { agentId: 'core-2', leaseMs: 60_000, ...REVIEW });
  store.reopen(f.board, f.id, { agentId: 'coordinator', note: 'the criterion needs correction' });
  assert.deepEqual(f.jobRows(), before);
});

test('clause 4: with runs_store off, reserve holds its lease on a job row as before [B2]', t => {
  const f = fixture(t, false);
  store.reserveReview(f.board, f.id, { agentId: 'core-2', leaseMs: 60_000, ...REVIEW });
  assert.equal(f.run(), undefined);
  assert.equal(f.board.db.prepare('SELECT job_lease_owner AS owner FROM job WHERE job_id = ?').get(`review:${f.id}`).owner, 'core-2');
});
