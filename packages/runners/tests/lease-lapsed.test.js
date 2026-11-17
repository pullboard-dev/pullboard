/** A gate job whose runner lease lapsed goes to another capable runner, and the first runner cannot record a result for it [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../store/tests/fixtures/cell.js';
import { LEASE_MS } from '../../jobs/index.js';
import { claimJob } from '../../api/index.js';
import { jobView } from '../../jobs/index.js';
import { offerJob } from '../../api/index.js';
import { postReceipt } from '../../api/index.js';
import { renewJob } from '../../api/index.js';

const boardWith = t => cellBoard(t, ':memory:').db;

test('runners.lease-lapsed.a-gate-job-whose-runner-lease: clause 1: a gate job whose runner lease lapsed is claimed by another capable runner [C7,P7]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:8919', kind: 'gate', needs: ['node22', 'browser'], now: 1 });
  const first = claimJob(db, { runner: 'r-first', capabilities: ['node22', 'browser'], now: 100 });
  assert.equal(first.job, 'gate:8919');
  assert.equal(claimJob(db, { runner: 'r-second', capabilities: ['node22', 'browser'], now: 100 + LEASE_MS }), null, 'a lease ending now is still live');
  const lapsed = 100 + LEASE_MS + 1;
  assert.equal(claimJob(db, { runner: 'r-plain', capabilities: ['node22'], now: lapsed }), null, 'a runner without the job\'s needs does not take it');
  const second = claimJob(db, { runner: 'r-second', capabilities: ['node22', 'browser'], now: lapsed });
  assert.deepEqual([second.job, second.attempt], ['gate:8919', 2]);
  assert.deepEqual([jobView(db, 'gate:8919').leaseOwner, jobView(db, 'gate:8919').attempt], ['r-second', 2]);
});

test('runners.lease-lapsed.the-first-runner-if-it-returns: clause 2: the first runner, if it returns, cannot renew or record a result for the job another runner took [C7,P7]', t => {
  const db = boardWith(t);
  offerJob(db, { id: 'gate:8919', kind: 'gate', now: 1 });
  const first = claimJob(db, { runner: 'r-first', capabilities: [], now: 100 });
  const lapsed = 100 + LEASE_MS + 1;
  const second = claimJob(db, { runner: 'r-second', capabilities: [], now: lapsed });
  assert.throws(() => renewJob(db, { job: 'gate:8919', runner: 'r-first', token: first.token, now: lapsed + 1 }), error => error.code === 'JOB_LEASE_MOVED');
  assert.throws(() => postReceipt(db, { job: 'gate:8919', runner: 'r-first', token: first.token, receipt: { status: 0 }, now: lapsed + 2 }), error => error.code === 'JOB_LEASE_MOVED');
  assert.equal(jobView(db, 'gate:8919').steps.some(step => step.name === 'receipt'), false, 'the refused runner recorded nothing');
  const posted = postReceipt(db, { job: 'gate:8919', runner: 'r-second', token: second.token, receipt: { status: 0 }, now: lapsed + 3 });
  assert.equal(posted.recorded, true);
});
