/** The scheduled claim watchdog sweep nudges, releases and orders its passes through the health door [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScheduledClaimWatchdog } from '../../../index.js';
import { sweepClaims } from '../../../index.js';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const minutes = count => new Date(T0 + count * 60_000).toISOString();

test('health.sweep.nudge-after-idle: the scheduled sentinel sweep sends one durable nudge after 30 idle minutes and observes the 10-minute release plan [B4,C7,#2856,clause 1,clause 2]', () => {
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

test('health.sweep.release-before-nudge: the scheduled sentinel path runs stale-claim release before the watchdog nudge pass [B4,C7,#2856,clause 2]', async t => {
  const order = [];
  const snapshot = { claims: [] };
  const ctx = { clock: { now: () => new Date(T0) }, config: { health: {} }, io: {} };
  const board = cellBoard(t, ':memory:', ctx.clock);
  const result = await sweepClaims(ctx, board, 'core-1', async (_ctx, _board, operation) => { order.push(operation); }, {
    items: [], agents: [],
    recordClaimWorktrees: () => order.push('record'),
    captureLapsedClaims: () => { order.push('capture'); return snapshot; },
    captureClaimWatchdogSnapshot: () => { order.push('watchdog-capture'); return snapshot; },
    runScheduledClaimWatchdog: () => order.push('watchdog'),
  });
  assert.deepEqual(order, ['record', 'capture', 'maintainStaleState', 'watchdog-capture', 'watchdog']);
  assert.equal(result, snapshot);
});

test('health.sweep.stalled-reaches-watchdog: a claim already marked stalled still reaches the watchdog when stale-state has no new action [B4,C7,#2856]', async t => {
  const order = [];
  const ctx = { clock: { now: () => new Date(T0 + 30 * 60_000) }, config: { health: {} }, io: {} };
  const board = cellBoard(t, ':memory:', ctx.clock);
  const watchSnapshot = { claims: [{ id: 7, actor: 'core-1' }] };
  const result = await sweepClaims(ctx, board, 'core-1', async (_ctx, _board, operation) => { order.push(operation); }, {
    items: [], agents: [], recordClaimWorktrees: () => order.push('record'),
    captureLapsedClaims: () => { order.push('no-new-stale-action'); return null; },
    captureClaimWatchdogSnapshot: () => { order.push('watchdog-capture'); return watchSnapshot; },
    runScheduledClaimWatchdog: () => order.push('watchdog'),
  });
  assert.deepEqual(order, ['record', 'no-new-stale-action', 'watchdog-capture', 'watchdog']);
  assert.equal(result, null);
});
