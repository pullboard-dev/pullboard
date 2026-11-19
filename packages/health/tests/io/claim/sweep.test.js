/** The scheduled claim watchdog sweep nudges, releases and orders its passes through the health door [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScheduledClaimWatchdog } from '../../../index.js';
import { sweepClaims } from '../../../index.js';
import { recordClaimSilence } from '../../../index.js';
import { readClaimSilence } from '../../../index.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { readBoardMeta } from '../../../../store/index.js';
import { addItem } from '../../../../store/index.js';
import { claim } from '../../../../store/index.js';
import { logEvent } from '../../../../store/index.js';
import { register } from '../../../../store/index.js';
import { listItems } from '../../../../store/index.js';
import { release } from '../../../../store/index.js';
import { openCellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { closeCellBoard } from '../../../../board/tests/fixtures/cell-board.js';
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

/** A real board file with one item claimed at T0 by a seat whose item folder holds no commit, and a clock the test moves. */
function silentClaim(t) {
  const directory = privateFixtureFiles('pullboard-silence-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const clock = { at: T0, now: () => new Date(clock.at) };
  const board = openCellBoard(file, clock);
  const seat = register(board, { lane: 'core', path: join(directory, 'seat'), route: 'strong' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Silent work', criterion: 'Work' });
  claim(board, id, { agentId: seat, lane: 'core', leaseMs: 86_400_000, freeze: () => ({ text: 'Work', digest: 'bar' }) });
  const count = (at, ports = { seats: () => [] }) => {
    clock.at = T0 + at * 60_000;
    recordClaimSilence(board, listItems(board), clock.at, ports);
    return readClaimSilence(board, id)?.sweeps ?? 0;
  };
  return { board, clock, file, seat, id, count, directory };
}

test('health.io-claim-sweep.counts-silent-sweeps: recordClaimSilence counts one per sweep for an hour of silence, stores it in board_meta, restarts on a new episode and on any sign of life, and survives a fresh board handle [C7,#12091,clause 1]', t => {
  const { board, clock, file, seat, id, count } = silentClaim(t);
  assert.equal(count(59), 0, 'under 60 minutes is not silence');
  assert.equal(count(60), 1);
  assert.equal(count(70), 2);
  const stored = JSON.parse(readBoardMeta(board.db, `claim_silence:${id}`));
  assert.deepEqual(stored, { episode: stored.episode, since: new Date(T0).toISOString(), sweeps: 2 });
  closeCellBoard(board);
  const reopened = openCellBoard(file, clock);
  t.after(() => { try { closeCellBoard(reopened); } catch { /* closed below */ } });
  assert.equal(readClaimSilence(reopened, id).sweeps, 2, 'the count lives on the board, not in memory');
  recordClaimSilence(reopened, listItems(reopened), T0 + 80 * 60_000, { seats: () => [] });
  assert.equal(readClaimSilence(reopened, id).sweeps, 3);
  reopened.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify({ episode: 0, since: 'x', sweeps: 9 }), `claim_silence:${id}`);
  recordClaimSilence(reopened, listItems(reopened), T0 + 90 * 60_000, { seats: () => [] });
  assert.equal(readClaimSilence(reopened, id).sweeps, 1, 'a new claim episode restarts the count');
  clock.at = T0 + 95 * 60_000;
  logEvent(reopened, seat, 'fact', id, { id: 'alive', kind: 'note', text: 'still here', ref: null, supersedes: null });
  recordClaimSilence(reopened, listItems(reopened), T0 + 100 * 60_000, { seats: () => [] });
  assert.equal(readClaimSilence(reopened, id), null, 'an event by the seat ends the silence');
  recordClaimSilence(reopened, listItems(reopened), T0 + 160 * 60_000, { seats: () => [] });
  assert.equal(readClaimSilence(reopened, id).sweeps, 1, 'an hour after that event the count starts again');
});

test('health.io-claim-sweep.sign-of-life-ends-silence: a heartbeat or an item-folder commit also ends the silence [C7,#12091,clause 1]', t => {
  const { board, id, seat, count } = silentClaim(t);
  assert.equal(count(61), 1);
  assert.equal(count(70, { seats: (_board, owners) => owners.map(seat => ({ ...seat, heartbeatAt: new Date(T0 + 65 * 60_000).toISOString() })) }), 0);
  assert.equal(count(130, { seats: () => [], commitAt: () => new Date(T0 + 100 * 60_000).toISOString() }), 0);
  assert.equal(count(161, { seats: () => [], commitAt: () => new Date(T0 + 100 * 60_000).toISOString() }), 1);
  release(board, id, seat, 'finished', undefined, 'OTHER');
  assert.equal(count(170), 0, 'a claim that ended is no longer counted');
});

test('health.io-claim-sweep.records-silence: sweepClaims records the silence count once per sweep through the production path [C7,#12091,clause 2]', async t => {
  const { board, clock, id } = silentClaim(t);
  clock.at = T0 + 61 * 60_000;
  const ctx = { clock, config: { health: {} }, io: {} };
  const ports = { recordClaimWorktrees: () => {}, captureLapsedClaims: () => null,
    captureClaimWatchdogSnapshot: () => ({ claims: [] }), runScheduledClaimWatchdog: () => {}, silence: { seats: () => [] } };
  await sweepClaims(ctx, board, 'sentinel', async () => {}, ports);
  assert.equal(readClaimSilence(board, id).sweeps, 1);
  clock.at += 10 * 60_000;
  await sweepClaims(ctx, board, 'sentinel', async () => {}, ports);
  assert.equal(readClaimSilence(board, id).sweeps, 2);
});
