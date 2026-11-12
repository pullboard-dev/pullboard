/** A seat whose session ended is gone and leaves the idle share; a live idle builder stays in it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seatSessionGone } from '../../../../packages/seats/index.js';
import { compareFlowWindows } from '../../../../packages/stats/index.js';
import {
  BASE,
  fixture,
} from '../../../../packages/store/tests/fixtures/stats/compare.js';

const MINUTE = 60_000;
const NOW = BASE + 120 * MINUTE;

test('clause 1: a seat with no live session process and no activity past the stale interval is gone [C7]', () => {
  const quiet = { lastActivityAt: NOW - 45 * MINUTE, now: NOW };
  assert.equal(seatSessionGone({ ...quiet, sessionLive: false }), true);
  assert.equal(seatSessionGone({ ...quiet, sessionLive: true }), false, 'a live session that is quiet is idle, not gone');
  assert.equal(seatSessionGone({ ...quiet }), false, 'an unknown session is never gone from silence alone');
  assert.equal(seatSessionGone({ sessionLive: false, lastActivityAt: NOW - 5 * MINUTE, now: NOW }), false, 'recent activity is not gone');
  assert.equal(seatSessionGone({ sessionLive: false, lastActivityAt: NOW - 20 * MINUTE, now: NOW, staleMs: 10 * MINUTE }), true);
});

test('clause 2: a gone seat is not in the idle share, and a live idle builder still is [C7]', t => {
  const box = fixture(t);
  const history = box.history();
  const window = { now: NOW, windowMinutes: 60, complete: true };
  const live = compareFlowWindows(history, window).current;
  assert.equal(live.observedSeats, 2);
  assert.equal(live.agentHours, 2);
  assert.ok(live.idleHours > 0 && live.idleShare > 0, 'the live seats are idle part of the hour');
  const nobody = compareFlowWindows(history, { ...window, gone: new Map() }).current;
  assert.deepEqual(nobody, live, 'no gone seat changes nothing');
  const gone = compareFlowWindows(history, { ...window, gone: new Map([['review-1', BASE + 60 * MINUTE]]) }).current;
  assert.equal(gone.observedSeats, 1, 'the gone seat leaves the cohort');
  assert.equal(gone.agentHours, 1, 'and its hour leaves the budget');
  assert.ok(gone.idleHours < live.idleHours, 'its quiet time is no longer idle time');
  assert.ok(gone.idleShare > 0, 'the live builder core-1 is still idle part of the hour');
});
