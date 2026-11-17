/** The job shadow compare reads the job in the writer's own transaction, so a receipt racing a runner's later move cannot read as a job.step disagreement [C7,#9360]. */
/** @pullboard-test-input packages/api/src/io/jobs.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { readShadow } from '../../../../store/index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';
import { provideJobTable } from '../../../index.js';
import { renewJob } from '../../../index.js';

const T0 = Date.parse('2026-11-16T17:42:00.000Z');
const LEASE_MS = 120_000;

/** Whether the connection is inside a transaction: a second BEGIN is refused only then. */
function inTransaction(db) {
  try { db.exec('BEGIN IMMEDIATE'); } catch { return true; }
  db.exec('ROLLBACK');
  return false;
}

/** A job table that answers a holder's renew and receipt as the real table does, and notes whether it read the row inside a transaction. */
function recording(reads, receiptStep) {
  return (snapshot, move) => {
    reads.push(inTransaction(reads.db));
    if (move.runner !== snapshot.job?.claim?.runner || move.token !== snapshot.job?.claim?.token) return { refused: { code: 'JOB_LEASE_MOVED' } };
    if (move.name === 'receipt') return { patch: { job: { ...snapshot.job, step: receiptStep ?? 'done', owner: null, leaseUntil: 0 } } };
    return { patch: { job: { ...snapshot.job, leaseUntil: snapshot.now + LEASE_MS } } };
  };
}

/** A shadowed board db with one claimed shard job, like gate:2991:...:shard:15 in the recorded disagreement. */
function claimed(t, reads, receiptStep) {
  const db = cellBoard(t, ':memory:').db;
  db.movesShadow = true;
  reads.db = db;
  provideJobTable(recording(reads, receiptStep));
  t.after(() => provideJobTable(null));
  offerJob(db, { id: 'gate:2991:78fcefb3d274:mwjjn31j:shard:15', kind: 'gate-shard', needs: [], now: T0 });
  const claim = claimJob(db, { runner: 'r-holder', now: T0 });
  return { db, id: 'gate:2991:78fcefb3d274:mwjjn31j:shard:15', token: claim.token };
}

test('api.jobs-job-shadow-agree.job-table-reads-row-inside: clause 1: the job table reads the row inside the writer\'s transaction, and a renew then a receipt compare with no disagreement [C7,#9360]', t => {
  const reads = [];
  const { db, id, token } = claimed(t, reads);
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 });
  postReceipt(db, { job: id, runner: 'r-holder', token, receipt: { status: 0 }, now: T0 + 2_000 });
  assert.deepEqual([...reads], [true, true], 'every table read happened inside the write transaction');
  const counts = readShadow({ db }, 'job');
  assert.equal(counts.compared, 2);
  assert.equal(counts.disagreed, 0, `the job table agreed: ${JSON.stringify(counts.last)}`);
});

test('api.jobs-job-shadow-agree.table-answer-whose-step-genuinely: clause 2: a table answer whose step genuinely differs from the writer\'s still records its differing path [C7,#9360]', t => {
  const reads = [];
  const { db, id, token } = claimed(t, reads, 'claimed');
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 });
  postReceipt(db, { job: id, runner: 'r-holder', token, receipt: { status: 0 }, now: T0 + 2_000 });
  const counts = readShadow({ db }, 'job');
  assert.equal(counts.compared, 2);
  assert.equal(counts.disagreed, 1, 'the receipt\'s step differs; the renew agrees');
  assert.equal(counts.last[0].differs, 'job.step');
});
