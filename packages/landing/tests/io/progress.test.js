/** @pullboard-test-input packages/landing/src/io/progress.js */
/** A landing batch is stopped for no progress at exactly two minutes, and only a changed board, log, runner job or CPU counts as progress [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANDING_STALL_MS } from '../../src/io/progress.js';
import { landingProgressSnapshot } from '../../src/io/progress.js';
import { landingProgressed } from '../../src/io/progress.js';
import { landingStallDescription } from '../../src/io/progress.js';
import { landingStallExpired } from '../../src/io/progress.js';

const batch = { id: 'b1', revision: 4, state: 'gating', logPath: '/log' };

test('landing.progress.the-stall-limit-is-two-minutes: clause 1: the stall limit is two minutes, and a batch is stopped at the limit but not a millisecond before [B3,R3,C7]', () => {
  assert.equal(LANDING_STALL_MS, 120_000);
  const start = 1_000_000;
  assert.equal(landingStallExpired(start, start + 119_999), false, 'one millisecond short of two minutes keeps the batch');
  assert.equal(landingStallExpired(start, start + 120_000), true, 'exactly two minutes ends it');
  assert.equal(landingStallExpired(start, start + 600_000), true);
  assert.equal(landingStallExpired(start, start + 30_000, 30_000), true, 'a caller limit replaces the default');
  assert.equal(landingStallExpired(null, start), false, 'no recorded progress time never stalls');
  assert.equal(landingStallExpired(start, Number.NaN), false, 'an unreadable clock never stalls');
});

test('landing.progress.an-explanation-names-the-limit-in: clause 1: an explanation names the limit in minutes, the recorded state and the latest step [B3,R3,C7]', () => {
  assert.equal(landingStallDescription(batch, 'gate'), 'batch b1 made no progress for 2 minutes in state gating; last step gate');
  assert.match(landingStallDescription(batch, 'gate', 60_000), /for 1 minute in state/u);
  assert.match(landingStallDescription(batch, 'gate', 90_000), /for 90 s in state/u);
});

test('landing.progress.a-board-advance-new-log-bytes: clause 1: a board advance, new log bytes, a new runner job or more CPU time reset the stall; an identical snapshot does not [B3,R3,C7]', () => {
  const before = landingProgressSnapshot(batch, { logBytes: 10, runnerJobs: ['j2', 'j1'], cpuMs: 5 });
  assert.deepEqual(before.runnerJobs, ['j1', 'j2'], 'jobs are compared as a sorted set');
  assert.equal(landingProgressed(before, landingProgressSnapshot(batch, { logBytes: 10, runnerJobs: ['j1', 'j2'], cpuMs: 5 })), false, 'nothing moved');
  assert.equal(landingProgressed(null, before), true, 'a first look is progress');
  assert.equal(landingProgressed(before, landingProgressSnapshot({ ...batch, revision: 5 }, { logBytes: 10, runnerJobs: ['j1', 'j2'], cpuMs: 5 })), true, 'a board revision');
  assert.equal(landingProgressed(before, landingProgressSnapshot({ ...batch, state: 'merged' }, { logBytes: 10, runnerJobs: ['j1', 'j2'], cpuMs: 5 })), true, 'a state change');
  assert.equal(landingProgressed(before, landingProgressSnapshot(batch, { logBytes: 11, runnerJobs: ['j1', 'j2'], cpuMs: 5 })), true, 'log bytes');
  assert.equal(landingProgressed(before, landingProgressSnapshot(batch, { logBytes: 10, runnerJobs: ['j1', 'j2', 'j3'], cpuMs: 5 })), true, 'a new runner job');
  assert.equal(landingProgressed(before, landingProgressSnapshot(batch, { logBytes: 10, runnerJobs: ['j1'], cpuMs: 5 })), false, 'a finished job is not progress');
  assert.equal(landingProgressed(before, landingProgressSnapshot(batch, { logBytes: 10, runnerJobs: ['j1', 'j2'], cpuMs: 6 })), true, 'worker CPU time');
});
