/** Withdrawing a gate cancels its job and frees the runner lease, so the slot it held is claimable at once [C7,#3860,#10223]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cancelGateJob } from '../../../store/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { leasedJobs } from '../../../jobs/index.js';
import { claimJob } from '../../../api/index.js';
import { offerJob } from '../../../api/index.js';

test('runners.withdrawn-gate-slot.cancel-frees-the-slot-at-once: clause 1: with one runner slot held by a gate job, cancelGateJob frees that slot and the next claim for another job takes it without waiting for the lease to expire [C7,#3860]', t => {
  const board = cellBoard(t, ':memory:');
  const { db } = board;
  offerJob(db, { id: 'gate:7:abc:t', kind: 'gate', item: 7, candidate: 'abc', now: 1 });
  offerJob(db, { id: 'gate:8:abc:t', kind: 'gate', item: 8, candidate: 'abc', now: 2 });
  const held = claimJob(db, { runner: 'r-one', jobs: 1, now: 100 });
  assert.equal(held.job, 'gate:7:abc:t');
  const live = now => leasedJobs(db, { kind: 'gate', now }).filter(job => job.leaseOwner === 'r-one').map(job => job.id);
  assert.deepEqual(live(101), ['gate:7:abc:t'], 'the runner\'s one slot is held by the gate job\'s lease');
  assert.ok(jobView(db, 'gate:7:abc:t').leaseUntil > 101 + LEASE_MS / 2, 'and that lease is far from expiring');

  assert.deepEqual(cancelGateJob(board, 7, { now: 102 }), { written: true, jobs: ['gate:7:abc:t'] });
  assert.deepEqual(live(102), [], 'the slot is free the moment the withdraw lands');
  const next = claimJob(db, { runner: 'r-one', jobs: 1, now: 103 });
  assert.equal(next?.job, 'gate:8:abc:t', 'the freed slot takes the next job at once');
});
