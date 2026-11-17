/** The api job writer shadow-compares the job move table: renew, release and receipt by the claim's runner, and a stranger's refusal, give the table's answer [C7,#8310]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimJob } from '../../../../api/index.js';
import { offerJob } from '../../../../api/index.js';
import { postReceipt } from '../../../../api/index.js';
import { releaseJob } from '../../../../api/index.js';
import { renewJob } from '../../../../api/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { jobEngine } from '../../../index.js';
import { runTable } from '../../../index.js';

const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const LEASE_MS = 120_000;
const { rules, table } = jobEngine({ leaseMs: LEASE_MS, maxAttempts: 12 });

/** A board db with one claimed gate job and a shadow hook that keeps every compare. */
function claimed(t, id = 'gate:shadow') {
  const db = cellBoard(t, ':memory:').db;
  const seen = [];
  offerJob(db, { id, kind: 'gate', needs: [], now: T0 });
  const claim = claimJob(db, { runner: 'r-holder', now: T0 });
  assert.equal(claim.job, id);
  db.jobQueueShadow = { decide: (snapshot, move) => runTable(table, rules, snapshot, move), seen: (compare) => seen.push(compare) };
  return { db, seen, id, token: claim.token };
}

/** Each compare's table answer equals what the writer left on the row. */
function agreed(seen, moves) {
  assert.deepEqual(seen.map(compare => compare.move), moves);
  for (const compare of seen) assert.deepEqual(compare.wrote, compare.decided, `${compare.move} on ${compare.job}`);
}

test('moves.job-writer.a-renew-release-or-receipt-by-the: clause 1: a renew, release or receipt by the claim\'s runner leaves the job row the job table\'s patch names [C7]', t => {
  const { db, seen, id, token } = claimed(t);
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 });
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + LEASE_MS + 5_000 }); // a lapsed lease the runner still holds (#6546)
  releaseJob(db, { job: id, runner: 'r-holder', token, reason: 'handler threw', now: T0 + LEASE_MS + 6_000 });
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + LEASE_MS + 7_000 }); // renew after release: nothing changes
  postReceipt(db, { job: id, runner: 'r-holder', token, receipt: { status: 0 }, now: T0 + LEASE_MS + 8_000 });
  postReceipt(db, { job: id, runner: 'r-holder', token, receipt: { status: 0 }, now: T0 + LEASE_MS + 9_000 });
  agreed(seen, ['renew', 'renew', 'release', 'renew', 'receipt', 'receipt']);
  assert.equal(seen.at(-1).wrote.job.step, 'done');

  const free = claimed(t, 'gate:free');
  releaseJob(free.db, { job: free.id, runner: 'r-holder', token: free.token, backoff: false, draining: true, now: T0 + 1_000 });
  agreed(free.seen, ['release']);
  assert.equal(free.seen[0].wrote.job.leaseUntil, 0);
});

test('moves.job-writer.a-renew-release-or-receipt-from-a: clause 2: a renew, release or receipt from a runner without the current claim is refused JOB_LEASE_MOVED by both the writer and the job table [C7]', t => {
  const { db, seen, id, token } = claimed(t);
  for (const [runner, held] of [['r-other', token], ['r-holder', 'not-the-token']]) {
    assert.throws(() => renewJob(db, { job: id, runner, token: held, now: T0 + 1_000 }), { code: 'JOB_LEASE_MOVED' });
    assert.throws(() => releaseJob(db, { job: id, runner, token: held, now: T0 + 1_000 }), { code: 'JOB_LEASE_MOVED' });
    assert.throws(() => postReceipt(db, { job: id, runner, token: held, receipt: { status: 0 }, now: T0 + 1_000 }), { code: 'JOB_LEASE_MOVED' });
  }
  agreed(seen, ['renew', 'release', 'receipt', 'renew', 'release', 'receipt']);
  assert.ok(seen.every(compare => compare.decided.refused === 'JOB_LEASE_MOVED'));
});

test('moves.job-writer.a-board-without-the-shadow-hook-runs: clause 3: a board without the shadow hook runs no job table on these moves [C7]', t => {
  const { db, seen, id, token } = claimed(t);
  delete db.jobQueueShadow;
  renewJob(db, { job: id, runner: 'r-holder', token, now: T0 + 1_000 });
  releaseJob(db, { job: id, runner: 'r-holder', token, reason: 'stopping', now: T0 + 2_000 });
  postReceipt(db, { job: id, runner: 'r-holder', token, receipt: { status: 0 }, now: T0 + 3_000 });
  assert.deepEqual(seen, []);
});
