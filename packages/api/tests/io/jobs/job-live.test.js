/** With moves.live.job on, a runner's renew, release or receipt writes the job row the job table decides and is refused what the table refuses; off, the writer's own rules decide [C7,#8387]. */
/** @pullboard-test-input packages/api/src/io/jobs.js packages/jobs/src/io/lease.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';
import { provideJobTable } from '../../../index.js';
import { releaseJob } from '../../../index.js';
import { renewJob } from '../../../index.js';

const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const TABLE_LEASE = T0 + 7;
// The moves cell sits above the api cell, so this stands in for the job table: it refuses a stranger and answers the holder's move with a row the writer would not write itself.
const decides = (snapshot, move) => (move.runner === snapshot.job?.claim?.runner && move.token === snapshot.job?.claim?.token
  ? { patch: { job: { ...snapshot.job, leaseUntil: TABLE_LEASE, ...(move.name === 'renew' ? {} : { owner: null, ...(move.name === 'receipt' ? { step: 'done' } : {}) }) } } }
  : { refused: { code: 'JOB_LEASE_MOVED', message: 'the job table: not the holder', next: 'claim a new job' } });

/** A board db with one claimed gate job; `live` is the db's stand-in for the moves.live.job machine setting. */
function claimed(t, live, decide = decides) {
  const db = cellBoard(t, ':memory:').db;
  if (live !== undefined) db.movesLive = { job: live };
  provideJobTable(decide);
  t.after(() => provideJobTable(null));
  offerJob(db, { id: 'gate:live', kind: 'gate', needs: [], now: T0 });
  const claim = claimJob(db, { runner: 'r-holder', now: T0 });
  return { db, id: 'gate:live', token: claim.token };
}

/** The job row's step, owner and lease as stored. */
const rowOf = (db, id) => db.prepare('SELECT job_step step, job_lease_owner owner, job_lease_until leaseUntil FROM job WHERE job_id = ?').get(id);

test('api.jobs-job-live.moves-live-job-renew-release: clause 1: with moves.live.job on, a renew, a release and a receipt each write the job row the job table decides [C7,#8387]', t => {
  const renewing = claimed(t, true);
  renewJob(renewing.db, { job: renewing.id, runner: 'r-holder', token: renewing.token, now: T0 + 1_000 });
  assert.equal(rowOf(renewing.db, renewing.id).leaseUntil, TABLE_LEASE, 'the renewed lease is the table\'s');
  const releasing = claimed(t, true);
  releaseJob(releasing.db, { job: releasing.id, runner: 'r-holder', token: releasing.token, reason: 'stopping', now: T0 + 1_000 });
  assert.deepEqual({ ...rowOf(releasing.db, releasing.id) }, { step: 'claimed', owner: null, leaseUntil: TABLE_LEASE });
  const posting = claimed(t, true);
  postReceipt(posting.db, { job: posting.id, runner: 'r-holder', token: posting.token, receipt: { ok: true }, now: T0 + 1_000 });
  assert.deepEqual({ ...rowOf(posting.db, posting.id) }, { step: 'done', owner: null, leaseUntil: TABLE_LEASE });
});

test('api.jobs-job-live.moves-live-job-move-job: clause 2: with moves.live.job on, a move the job table refuses is refused with the table\'s code and writes nothing [C7,#8387]', t => {
  const { db, id, token } = claimed(t, true, () => ({ refused: { code: 'JOB_TABLE_REFUSED', message: 'the table says no', next: 'claim a new job' } }));
  const before = { ...rowOf(db, id) }, steps = db.prepare('SELECT COUNT(*) n FROM job_step').get().n;
  assert.throws(() => renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 }), { code: 'JOB_TABLE_REFUSED', next: 'claim a new job' });
  assert.deepEqual({ ...rowOf(db, id) }, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_step').get().n, steps);
});

test('api.jobs-job-live.job-table-throws-never-takes: clause 2: a job table that throws never takes the runner\'s move down; the writer\'s own rules decide it [C7,#8387]', t => {
  const { db, id, token } = claimed(t, true, () => { throw new Error('broken table'); });
  assert.equal(renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 }).renewed, true);
  assert.equal(rowOf(db, id).leaseUntil, T0 + 1_000 + 120_000);
});

test('api.jobs-job-live.moves-live-job-off-default: clause 3: with moves.live.job off (the default) the writer\'s own rules decide, whatever the table says [C7,#8387]', t => {
  const { db, id, token } = claimed(t, undefined, () => { throw new Error('the table must not run'); });
  assert.equal(renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 }).renewed, true);
  assert.equal(rowOf(db, id).leaseUntil, T0 + 1_000 + 120_000);
  assert.throws(() => renewJob(db, { job: id, runner: 'r-other', token, now: T0 + 2_000 }), { code: 'JOB_LEASE_MOVED' });
});
