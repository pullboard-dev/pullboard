/** A queued job past its kind's limit with no waiter is expired with a recorded reason, and a waited-on or offered one stays [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { QUEUED_EXPIRY_MS } from '../../index.js';
import { createJob } from '../../index.js';
import { expireQueuedJobs } from '../../index.js';
import { jobView } from '../../index.js';
import { touchLive } from '../../index.js';
import { writeStep } from '../../index.js';

const HOUR = 3_600_000;

test('jobs.expire.queued-over-limit: clause 1: a queued job older than its kind limit with no waiter is expired with a recorded reason [C7]', t => {
  const db = cellBoard(t, ':memory:').db;
  const now = 100 * HOUR;
  createJob(db, { id: 'old-flake', kind: 'flake-diagnose', now: now - QUEUED_EXPIRY_MS['flake-diagnose'] - 1 });
  createJob(db, { id: 'old-land', kind: 'land', now: now - QUEUED_EXPIRY_MS.land - 1 });
  createJob(db, { id: 'young-gate', kind: 'gate', now: now - QUEUED_EXPIRY_MS.gate + 1 });
  createJob(db, { id: 'waited-gate', kind: 'gate', now: now - 50 * HOUR });
  touchLive(db, ['waited-gate'], now - HOUR);
  createJob(db, { id: 'offered-gate', kind: 'gate', now: now - 50 * HOUR });
  writeStep(db, 'offered-gate', 'offered', {}, { now: now - 50 * HOUR });
  createJob(db, { id: 'other-kind', kind: 'review', now: now - 500 * HOUR });
  const expired = expireQueuedJobs(db, { now });
  assert.deepEqual(expired.map(job => job.id).sort(), ['old-flake', 'old-land']);
  const view = jobView(db, 'old-flake');
  assert.equal(view.step, 'done');
  const step = view.steps.find(entry => entry.name === 'expired');
  assert.match(step.payload.reason, /nobody waiting.*12 h limit for flake-diagnose/u);
  for (const kept of ['young-gate', 'waited-gate', 'offered-gate', 'other-kind']) assert.notEqual(jobView(db, kept).step, 'done', kept);
  assert.deepEqual(expireQueuedJobs(db, { now }), [], 'a second pass finds nothing left');
});
