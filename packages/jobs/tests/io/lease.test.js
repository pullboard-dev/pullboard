/** A job's lease is held by one driver at a time, renewed by its holder and reclaimable once it lapses [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { LEASE_MS } from '../../index.js';
import { createJob } from '../../index.js';
import { finishJob } from '../../index.js';
import { jobView } from '../../index.js';
import { leaseLapsed } from '../../index.js';
import { reclaimLapsed } from '../../index.js';
import { releaseLease } from '../../index.js';
import { renewLease } from '../../index.js';
import { takeJob } from '../../index.js';

const jobOn = (t, id = 'gate:1') => {
  const db = cellBoard(t, ':memory:').db;
  createJob(db, { id, kind: 'gate', now: 1 });
  return db;
};

test('a lease lapses strictly after its end, and a lease lasts two minutes by default [C7]', () => {
  assert.equal(LEASE_MS, 120_000);
  assert.equal(leaseLapsed(100, 100), false);
  assert.equal(leaseLapsed(100, 101), true);
});

test('takeJob gives the lease to one driver, refuses a second while it is live, and gives it over once it lapsed [C7]', t => {
  const db = jobOn(t);
  const first = takeJob(db, 'gate:1', 'w1', { now: 1000 });
  assert.equal(first.taken, true);
  assert.deepEqual([first.job.leaseOwner, first.job.leaseUntil], ['w1', 1000 + LEASE_MS]);
  const rival = takeJob(db, 'gate:1', 'w2', { now: 1000 + LEASE_MS });
  assert.equal(rival.taken, false, 'a lease ending now is still live');
  assert.equal(rival.job.leaseOwner, 'w1');
  const later = takeJob(db, 'gate:1', 'w2', { now: 1001 + LEASE_MS, leaseMs: 50 });
  assert.equal(later.taken, true);
  assert.deepEqual([later.job.leaseOwner, later.job.leaseUntil], ['w2', 1001 + LEASE_MS + 50]);
  assert.throws(() => takeJob(db, 'gate:1', ''), error => error.code === 'JOB_OWNER');
  assert.throws(() => takeJob(db, 'gate:none', 'w1'), error => error.code === 'JOB_MISSING');
});

test('only the holder renews a live lease, and a lapsed lease cannot be renewed [C7]', t => {
  const db = jobOn(t);
  takeJob(db, 'gate:1', 'w1', { now: 1000, leaseMs: 100 });
  assert.equal(renewLease(db, 'gate:1', 'w2', { now: 1050 }), false);
  assert.equal(renewLease(db, 'gate:1', 'w1', { now: 1050, leaseMs: 500 }), true);
  assert.equal(jobView(db, 'gate:1').leaseUntil, 1550);
  assert.equal(renewLease(db, 'gate:1', 'w1', { now: 1551 }), false, 'a driver that let it lapse takes the job again instead');
});

test('reclaimLapsed names each lapsed lease with how long ago it ended, oldest first, and leaves live leases alone [C7]', t => {
  const db = jobOn(t, 'a');
  createJob(db, { id: 'b', kind: 'gate', now: 1 });
  createJob(db, { id: 'c', kind: 'gate', now: 1 });
  takeJob(db, 'a', 'w1', { now: 1, leaseMs: 300 });
  takeJob(db, 'b', 'w2', { now: 1, leaseMs: 100 });
  takeJob(db, 'c', 'w3', { now: 1, leaseMs: 5000 });
  assert.deepEqual(reclaimLapsed(db, { now: 1000 }), [
    { id: 'b', kind: 'gate', step: 'queued', leaseOwner: 'w2', lapsedMs: 899 },
    { id: 'a', kind: 'gate', step: 'queued', leaseOwner: 'w1', lapsedMs: 699 },
  ]);
  assert.deepEqual(reclaimLapsed(db, { now: 50 }), []);
});

test('releaseLease frees the lease for its holder only [C7]', t => {
  const db = jobOn(t);
  takeJob(db, 'gate:1', 'w1', { now: 1000 });
  assert.equal(releaseLease(db, 'gate:1', 'w2', { now: 1001 }), false);
  assert.equal(releaseLease(db, 'gate:1', 'w1', { now: 1002 }), true);
  const view = jobView(db, 'gate:1');
  assert.deepEqual([view.leaseOwner, view.leaseUntil, view.updated], [null, 0, 1002]);
  assert.equal(takeJob(db, 'gate:1', 'w2', { now: 1003 }).taken, true, 'a released job is free at once');
});

test('finishJob marks the job done for its holder or an unleased or lapsed job, but not against a live rival [C7]', t => {
  const db = jobOn(t, 'held');
  createJob(db, { id: 'free', kind: 'gate', now: 1 });
  createJob(db, { id: 'old', kind: 'gate', now: 1 });
  takeJob(db, 'held', 'w1', { now: 1000, leaseMs: 1000 });
  assert.equal(finishJob(db, 'held', 'w2', { now: 1500 }), false);
  assert.equal(jobView(db, 'held').step, 'queued');
  assert.equal(finishJob(db, 'held', 'w1', { now: 1500 }), true);
  assert.deepEqual([jobView(db, 'held').step, jobView(db, 'held').leaseOwner], ['done', null]);
  assert.equal(finishJob(db, 'free', 'w9', { now: 1500 }), true);
  takeJob(db, 'old', 'w1', { now: 1, leaseMs: 10 });
  assert.equal(finishJob(db, 'old', 'w2', { now: 5000 }), true, 'a lapsed lease no longer protects its holder');
  assert.equal(jobView(db, 'old').step, 'done');
});
