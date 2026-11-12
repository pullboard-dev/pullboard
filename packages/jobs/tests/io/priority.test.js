/** Runner jobs carry a priority class set at offer; a claim takes the highest class first, keeps each class's reserve, and with no reserve claims as before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { claimableJobs } from '../../index.js';
import { createJob } from '../../index.js';
import { takeJob } from '../../index.js';
import { writeStep } from '../../index.js';

const RESERVE = { interactive: 0.3, gate: 0.3, landing: 0.2, background: 0.1 };

/** Offer one job as the enqueuing command does: its kind and the class it names. */
function offer(db, id, kind, priority, now) {
  createJob(db, { id, kind, now });
  writeStep(db, id, 'offered', { needs: [], priority }, { now });
}

/** A board whose queue holds, oldest first, a background sweep, a landing, a gate and an agent's test run. */
function mixedQueue(t) {
  const { db } = cellBoard(t, ':memory:');
  offer(db, 'main-test:1', 'main-test', 'background', 1);
  offer(db, 'land:1', 'land', 'landing', 2);
  offer(db, 'gate:1', 'gate', 'gate', 3);
  offer(db, 'test:1', 'test', 'interactive', 4);
  return db;
}

/** One claim by runner r1: the first job in claim order, leased to it; null when nothing is open. */
function claim(db, { reserve = null, slots = null } = {}) {
  const [first] = claimableJobs(db, { runner: 'r1', now: 10, limit: 500, reserve, slots });
  if (!first) return null;
  assert.equal(takeJob(db, first.row.job_id, 'r1', { now: 10 }).taken, true);
  return first.row.job_id;
}

test('a runner claims the highest priority class first: interactive, gate, landing, then background [C7]', t => {
  const db = mixedQueue(t);
  assert.deepEqual([1, 2, 3, 4].map(() => claim(db, { reserve: {}, slots: 8 })), ['test:1', 'gate:1', 'land:1', 'main-test:1']);
  assert.equal(claim(db, { reserve: {}, slots: 8 }), null, 'the queue is empty once every class is taken');
});

test('a class with a reserve still gets its reserved slot under full load [C7]', t => {
  const queue = () => {
    const { db } = cellBoard(t, ':memory:');
    for (let n = 1; n <= 6; n += 1) offer(db, `test:${n}`, 'test', 'interactive', n);
    offer(db, 'main-test:1', 'main-test', 'background', 9);
    return db;
  };
  // A 4-slot runner: interactive outranks background for three slots, then the last free slot is background's reserve.
  const reserved = queue();
  assert.deepEqual([1, 2, 3, 4].map(() => claim(reserved, { reserve: RESERVE, slots: 4 })), ['test:1', 'test:2', 'test:3', 'main-test:1']);
  // With no background reserve, the same full runner gives every slot to interactive runs.
  const unreserved = queue();
  assert.deepEqual([1, 2, 3, 4].map(() => claim(unreserved, { reserve: { interactive: 0.5 }, slots: 4 })), ['test:1', 'test:2', 'test:3', 'test:4']);
});

test('with no priority setting the claim order is unchanged: landings, then test runs, then the rest by age [C7]', t => {
  const db = mixedQueue(t);
  assert.deepEqual([1, 2, 3, 4].map(() => claim(db, { slots: 4 })), ['land:1', 'test:1', 'main-test:1', 'gate:1']);
});
