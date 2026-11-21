/** The scheduled claim watchdog sweep nudges, releases and orders its passes through the health door [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScheduledClaimWatchdog } from '../../../index.js';
import { sweepClaims } from '../../../index.js';
import { recordClaimSilence } from '../../../index.js';
import { readClaimSilence } from '../../../index.js';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { readBoardMeta } from '../../../../store/index.js';
import { addItem } from '../../../../store/index.js';
import { claim } from '../../../../store/index.js';
import { logEvent } from '../../../../store/index.js';
import { register } from '../../../../store/index.js';
import { listItems } from '../../../../store/index.js';
import { release } from '../../../../store/index.js';
import { events } from '../../../../store/index.js';
import { maintainStaleState } from '../../../../store/index.js';
import { policyRepository } from '../../../../store/tests/fixtures/submit.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
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

/**
 * A real board file under a machine stall: `count` seats each hold a claim with a 24-hour lease and a git item folder, and
 * every one has been quiet since T0, so most claimed seats are quiet together. A sweep runs the production path with the
 * real capture and the real ordered stale-state move.
 */
function stalledBoard(t, count, quietEvents = []) {
  const { board, clock, directory, seat, id } = silentClaim(t);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const sentinel = register(board, { lane: 'coordinator', path: join(directory, 'sentinel') });
  const claims = [{ seat, id }];
  for (let index = 1; index < count; index += 1) {
    const path = join(directory, `seat${index}`);
    const other = register(board, { lane: 'core', path, route: 'strong' });
    const item = addItem(board, { by: 'coordinator', lane: 'core', title: `Silent work ${index}`, criterion: 'Work' });
    claim(board, item, { agentId: other, lane: 'core', leaseMs: 86_400_000, freeze: () => ({ text: 'Work', digest: 'bar' }) });
    claims.push({ seat: other, id: item });
  }
  for (const { seat: holder } of claims) {
    const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(holder).agent_path;
    mkdirSync(path, { recursive: true });
    policyRepository(path);
    writeFileSync(join(path, 'work.txt'), 'base\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'fixture');
    writeFileSync(join(path, 'work.txt'), 'changed\n');
  }
  for (const [index, at] of quietEvents.entries()) {
    clock.at = T0 + at * 60_000;
    logEvent(board, claims[index].seat, 'fact', claims[index].id, { id: `alive-${index}`, kind: 'note', text: 'still here', ref: null, supersedes: null });
  }
  const ctx = { clock, config: { health: {} }, io: {} };
  const ordered = async (_ctx, target, _operation, [args]) => maintainStaleState(target, args);
  const sweep = async at => {
    clock.at = T0 + at * 60_000;
    return sweepClaims(ctx, board, sentinel, ordered, { recordClaimWorktrees: () => {}, captureClaimWatchdogSnapshot: () => ({ claims: [] }),
      runScheduledClaimWatchdog: () => {}, silence: { seats: () => [] }, shout: () => {} });
  };
  const state = target => board.db.prepare('SELECT item_status,item_owner FROM item WHERE item_id=?').get(target);
  const last = target => events(board, { itemId: target }).findLast(event => event.event_kind === 'release');
  return { board, claims, sweep, state, last, git, ctx };
}

test('health.io-claim-sweep.stall-releases-hour-silent: clause 1: with the machine stall set on every sweep, a claim silent 60+ minutes on 3 consecutive sweeps is released with a handoff naming keep/<id> even with a future lease, and a claim with a gate in flight or silent on fewer than 3 sweeps is kept [C7,#12116,clause 1,clause 2]', async t => {
  const { board, claims, sweep, state, last, git, ctx } = stalledBoard(t, 3);
  const [first, second, flying] = claims;
  const queued = () => board.db.prepare(`INSERT OR REPLACE INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
    VALUES ('gate-flight', 'gate', ?, 'offered', NULL, 0, ?, ?)`).run(flying.id, ctx.clock.at - 60_000, ctx.clock.at - 60_000);
  queued();
  await sweep(61);
  assert.ok(ctx.machineStall, 'every seat is quiet, so the sweep reads a machine stall');
  assert.equal(state(first.id).item_status, 'claimed', 'one silent sweep releases nothing');
  await sweep(71);
  assert.equal(state(first.id).item_status, 'claimed', 'two silent sweeps release nothing');
  assert.equal(readClaimSilence(board, first.id).sweeps, 2);
  queued();
  await sweep(81);
  assert.ok(ctx.machineStall, 'the stall is still set on the third sweep');
  for (const held of [first, second]) {
    assert.equal(state(held.id).item_status, 'open', `#${held.id} is released on the third silent sweep`);
    assert.equal(state(held.id).item_owner, null);
    const event = last(held.id);
    const detail = JSON.parse(event.event_detail);
    assert.match(detail.reason, new RegExp(`work kept on keep/${held.id} and refs/pullboard/handoffs/${held.id}/dirty-`, 'u'), 'the release names the keep ref');
    assert.equal(detail.idleClaim.kept.branch, `keep/${held.id}`);
    assert.equal(detail.reasonCode, 'SEAT_GONE');
    const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(held.seat).agent_path;
    assert.equal(git(path, 'rev-parse', `keep/${held.id}`).trim(), detail.idleClaim.kept.head, 'the branch holds the saved head');
  }
  assert.equal(state(flying.id).item_status, 'claimed', 'a claim with its gate in flight is never released as silent');
});

test('health.io-claim-sweep.stall-keeps-young-silence: clause 1: under the machine stall, seats silent under 60 minutes keep their claims on every sweep and the count starts at the hour [C7,#12116,clause 1,clause 2]', async t => {
  const { board, claims, sweep, state, ctx } = stalledBoard(t, 2, [30, 35]);
  for (const at of [61, 71, 81]) {
    await sweep(at);
    assert.ok(ctx.machineStall, 'the stall is set');
    for (const held of claims) {
      assert.equal(state(held.id).item_status, 'claimed', `#${held.id} is kept at minute ${at}`);
      assert.equal(readClaimSilence(board, held.id), null, 'under an hour of silence is not counted');
    }
  }
  await sweep(95);
  assert.equal(readClaimSilence(board, claims[0].id).sweeps, 1, 'the count starts once the hour is reached');
  for (const held of claims) assert.equal(state(held.id).item_status, 'claimed', 'one sweep at the hour still keeps the claim');
});
