/** The claim watchdog nudges an idle live seat once, then releases the claim after the grace period [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planClaimWatchdog } from '../packages/seats/index.js';
import { runClaimWatchdog } from '../packages/seats/index.js';
import { runScheduledClaimWatchdog } from '../packages/health/src/shell/claim-sweep.js';
import { sweepClaims } from '../packages/health/src/shell/claim-sweep.js';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const minutes = count => new Date(T0 + count * 60_000).toISOString();

/** One claim made at minute 0 with no later activity unless a test overrides it. */
function claim(over = {}) {
  return { item: 7, owner: 'core-1', seatLive: true, claimedAt: minutes(0), lastCommitAt: null, lastSubmitAt: null, lastGateAt: null, ...over };
}

test('a live seat with no commit, submit or gate for 30 minutes gets exactly one nudge [B4]', () => {
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

test('a seat that is not otherwise live is not nudged [B4]', () => {
  const plan = planClaimWatchdog([claim({ seatLive: false })], new Map(), T0 + 90 * 60_000);
  assert.deepEqual(plan, { nudge: [], release: [], keep: [], cleared: [] });
});

test('a flagged claim with no progress 10 minutes after the nudge is released back to next [B4]', () => {
  const nudged = new Map([[7, minutes(30)]]);
  assert.deepEqual(planClaimWatchdog([claim()], nudged, T0 + 39 * 60_000).release, []);
  const released = [];
  const ports = { claims: () => [claim()], nudged, now: () => T0 + 40 * 60_000, nudge: () => assert.fail('no second nudge'), release: row => released.push(row.item) };
  assert.deepEqual(runClaimWatchdog(ports).release, [{ item: 7, owner: 'core-1', idleMs: 40 * 60_000 }]);
  assert.deepEqual(released, [7]);
  assert.equal(nudged.has(7), false, 'the flag is gone once the claim is released');
});

test('progress after the nudge clears the flag, and a submit or gate in the last 10 minutes is never touched [B4]', () => {
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

test('the scheduled sentinel sweep sends one durable nudge after 30 idle minutes and observes the 10-minute release plan [B4,C7,#2856,clause 1,clause 2]', () => {
  const history = [{ event_id: 1, event_at: minutes(0), event_by: 'core-1', event_kind: 'claim', event_detail: '{}' }];
  const sent = [];
  const ports = {
    seats: () => [{ agent_id: 'core-1', presence: 'live' }],
    events: () => history,
    getItem: () => ({ item_status: 'claimed', item_owner: 'core-1' }),
    work: () => ({ available: true, commitAt: minutes(0) }),
    shout: message => {
      sent.push(message);
      history.push({ event_id: history.length + 1, event_at: minutes(30), event_by: 'sentinel', event_kind: 'shout',
        event_detail: JSON.stringify(message.detail) });
    },
  };
  const snapshot = { claims: [{ id: 7, actor: 'core-1' }] };
  const ctx = { clock: { now: () => new Date(T0 + 30 * 60_000) } };
  assert.deepEqual(runScheduledClaimWatchdog(ctx, {}, snapshot, ports).nudge, [{ item: 7, owner: 'core-1' }]);
  assert.match(sent[0].text, /10-minute grace period/u);
  ctx.clock.now = () => new Date(T0 + 35 * 60_000);
  assert.deepEqual(runScheduledClaimWatchdog(ctx, {}, snapshot, ports).nudge, []);
  ctx.clock.now = () => new Date(T0 + 40 * 60_000);
  assert.deepEqual(runScheduledClaimWatchdog(ctx, {}, snapshot, ports).release, [{ item: 7, owner: 'core-1', idleMs: 40 * 60_000 }]);
});

test('the scheduled sentinel path runs stale-claim release before the watchdog nudge pass [B4,C7,#2856,clause 2]', async () => {
  const order = [];
  const snapshot = { claims: [] };
  const ctx = { clock: { now: () => new Date(T0) }, config: { health: {} }, io: {} };
  const result = await sweepClaims(ctx, {}, 'core-1', async (_ctx, _board, operation) => { order.push(operation); }, {
    items: [], agents: [],
    recordClaimWorktrees: () => order.push('record'),
    captureLapsedClaims: () => { order.push('capture'); return snapshot; },
    captureClaimWatchdogSnapshot: () => { order.push('watchdog-capture'); return snapshot; },
    runScheduledClaimWatchdog: () => order.push('watchdog'),
  });
  assert.deepEqual(order, ['record', 'capture', 'maintainStaleState', 'watchdog-capture', 'watchdog']);
  assert.equal(result, snapshot);
});

test('a claim already marked stalled still reaches the watchdog when stale-state has no new action [B4,C7,#2856]', async () => {
  const order = [];
  const ctx = { clock: { now: () => new Date(T0 + 30 * 60_000) }, config: { health: {} }, io: {} };
  const watchSnapshot = { claims: [{ id: 7, actor: 'core-1' }] };
  const result = await sweepClaims(ctx, {}, 'core-1', async (_ctx, _board, operation) => { order.push(operation); }, {
    items: [], agents: [], recordClaimWorktrees: () => order.push('record'),
    captureLapsedClaims: () => { order.push('no-new-stale-action'); return null; },
    captureClaimWatchdogSnapshot: () => { order.push('watchdog-capture'); return watchSnapshot; },
    runScheduledClaimWatchdog: () => order.push('watchdog'),
  });
  assert.deepEqual(order, ['record', 'no-new-stale-action', 'watchdog-capture', 'watchdog']);
  assert.equal(result, null);
});
