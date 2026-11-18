/** The claim watchdog nudges an idle live seat once, then releases the claim after the grace period [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planClaimWatchdog } from '../../index.js';
import { runClaimWatchdog } from '../../index.js';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const minutes = count => new Date(T0 + count * 60_000).toISOString();

/** One claim made at minute 0 with no later activity unless a test overrides it. */
function claim(over = {}) {
  return { item: 7, owner: 'core-1', seatLive: true, claimedAt: minutes(0), lastCommitAt: null, lastSubmitAt: null, lastGateAt: null, ...over };
}

test('seats.watchdog.one-nudge-after-30-min: a live seat with no commit, submit or gate for 30 minutes gets exactly one nudge [B4]', () => {
  const nudged = new Map();
  const sent = [];
  const ports = { claims: () => [claim()], nudged, now: () => T0 + 29 * 60_000, nudge: row => sent.push(row.item), release: () => assert.fail('no release') };
  assert.deepEqual(runClaimWatchdog(ports).nudge, [], 'not yet 30 minutes');
  ports.now = () => T0 + 30 * 60_000;
  assert.deepEqual(runClaimWatchdog(ports).nudge, [{ item: 7, owner: 'core-1' }]);
  ports.now = () => T0 + 35 * 60_000;
  runClaimWatchdog(ports);
  assert.deepEqual(sent, [7], 'the nudge is sent once');
  assert.equal(nudged.get(7), minutes(30));
});

test('seats.watchdog.not-live-not-nudged: a seat that is not otherwise live is not nudged [B4]', () => {
  const plan = planClaimWatchdog([claim({ seatLive: false })], new Map(), T0 + 90 * 60_000);
  assert.deepEqual(plan, { nudge: [], release: [], keep: [], cleared: [] });
});

test('seats.watchdog.flagged-claim-released: a flagged claim with no progress 10 minutes after the nudge is released back to next [B4]', () => {
  const nudged = new Map([[7, minutes(30)]]);
  assert.deepEqual(planClaimWatchdog([claim()], nudged, T0 + 39 * 60_000).release, []);
  const released = [];
  const ports = { claims: () => [claim()], nudged, now: () => T0 + 40 * 60_000, nudge: () => assert.fail('no second nudge'), release: row => released.push(row.item) };
  assert.deepEqual(runClaimWatchdog(ports).release, [{ item: 7, owner: 'core-1', idleMs: 40 * 60_000 }]);
  assert.deepEqual(released, [7]);
  assert.equal(nudged.has(7), false, 'the flag is gone once the claim is released');
});

test('seats.watchdog.progress-clears-flag: progress after the nudge clears the flag, and a submit or gate in the last 10 minutes is never touched [B4]', () => {
  const nudged = new Map([[7, minutes(30)]]);
  const committed = claim({ lastCommitAt: minutes(35) });
  assert.deepEqual(planClaimWatchdog([committed], nudged, T0 + 45 * 60_000).cleared, [7]);
  for (const key of ['lastSubmitAt', 'lastGateAt']) {
    const recent = claim({ [key]: minutes(41) });
    const plan = planClaimWatchdog([recent], new Map([[7, minutes(30)]]), T0 + 50 * 60_000);
    assert.deepEqual(plan.keep, [7], key);
    assert.deepEqual([plan.nudge, plan.release], [[], []], key);
  }
});
