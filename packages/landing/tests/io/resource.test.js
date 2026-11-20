/** A dead landing lease holder is reclaimed by the next lander within the lease period [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reclaimReason } from '../../src/io/resource.js';
import { renewWithBackoff } from '../../src/io/resource.js';
import { takeLandingResource } from '../../src/io/resource.js';
import { renewGuardedHeartbeat } from '../../src/io/worker.js';
import { retryableLandingRefusal } from '../../src/logic/retry.js';
import { landingFault } from '../../src/io/step/diagnose.js';
import * as store from '../../../store/index.js';
import { register as registerSeat } from '../../../store/index.js';
import { Refused } from '../../../kernel/index.js';
import { openCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

/** A pid that certainly belongs to no running process: a child that already exited. */
function deadPid() { return spawnSync(process.execPath, ['-e', '0']).pid; }

/** A linked-board holder recorded on one machine with its shared deadline. */
function holder(overrides = {}) {
  return { token: 'a'.repeat(8) + '-0000-0000-0000-' + 'b'.repeat(12), pid: deadPid(), lineage: 'lineage-1', machine: 'machine-a',
    since: '2026-01-01T00:00:00.000Z', until: '2026-01-01T00:02:00.000Z', generation: 3137, ...overrides };
}

const LATER = Date.parse('2026-01-01T00:03:00.000Z');

test('landing.resource.a-landing-lease-whose-holder-token: clause 1: a landing lease whose holder token has no live process on this machine is released by the next lander within 2 minutes, with a release event naming the reason [C7]', () => {
  const reason = reclaimReason(holder(), null, { now: LATER, machine: 'machine-a' });
  assert.match(reason, /holder process gone/u, 'a dead local holder with a stale heartbeat is reclaimed with a named reason');
  assert.equal(reclaimReason(holder(), null, { now: Date.parse('2026-01-01T00:01:00.000Z'), machine: 'machine-a' }), null, 'a heartbeat younger than 2 minutes is left alone');
  assert.equal(reclaimReason(holder({ pid: process.pid }), null, { now: LATER, machine: 'machine-a' }), null, 'a live holder is never reclaimed');
  assert.equal(reclaimReason(holder({ machine: 'machine-b' }), null, { now: LATER, machine: 'machine-a' }), null, 'a foreign machine holder is never judged by local pids');
});

test('landing.resource.a-waiting-lander-never-logs-foreign: clause 2: a waiting lander never logs foreign holders require explicit release for a holder on this machine whose process is dead [C7]', () => {
  // The waiting loop releases any holder with a reason before it reports a wait, so no wait message names a dead local holder.
  assert.ok(reclaimReason(holder({ machine: 'machine-a' }), null, { now: LATER, machine: 'machine-a' }));
  assert.ok(reclaimReason(holder({ lineage: null }), null, { now: LATER, machine: null }), 'an unlinked board releases a dead holder at once');
});

/** An open board whose accepted policy moves while any policy-judged write is open, as when main lands a policy change. */
function boardWithMovingPolicy(t) {
  let at = Date.parse('2026-01-01T00:00:00Z');
  const board = openCellBoard(':memory:', { now: () => new Date(at) });
  registerSeat(board, { lane: 'coordinator', path: '/renew/main' });
  t.after(() => store.closeBoard(board));
  let prepared = 0;
  /** The real frame shape: current at BEGIN, stale by the commit-time check. */
  const policyLanded = () => {
    Object.defineProperty(board, 'prepareWritePolicy', { configurable: true, value() {
      prepared += 1;
      return { current: () => true, enter() {}, leave() {},
        assertCurrent() { throw new Refused('POLICY_SNAPSHOT_STALE', 'accepted policy changed during this write; retry the command against current main'); } };
    } });
  };
  return { board, advance(ms) { at += ms; }, policyLanded, prepared: () => prepared };
}

test('landing.resource.clause-1-5672-a-landing-lease: clause 1 (#5672): a landing lease renewal while main lands a policy change renews the lease, never POLICY_SNAPSHOT_STALE [C7]', async t => {
  const box = boardWithMovingPolicy(t);
  const { board } = box;
  const lost = [];
  const lease = await takeLandingResource({ board, branch: 'refs/heads/main', onLost: error => lost.push(error.code),
    write: async (operation, args) => store[operation](board, ...args) });
  try {
    box.policyLanded();
    assert.throws(() => store.atomic(board, () => {}), { code: 'POLICY_SNAPSHOT_STALE' }, 'a policy-judged write refuses, so the board models the 11 Nov landing');
    const before = Date.parse(lease.assertCurrent().until);
    box.advance(5000);
    await lease.assertHeld();
    assert.ok(Date.parse(lease.assertCurrent().until) > before, 'the heartbeat moved the lease deadline');
    assert.deepEqual(lost, [], 'the landing kept its lease');
  } finally { delete board.prepareWritePolicy; await lease.release(); }
});

test('landing.resource.clause-1-5672-a-policy-snapshot: clause 1 (#5672): a POLICY_SNAPSHOT_STALE that escapes a landing is a retried landing fault, so the automatic worker never rethrows it [C7]', () => {
  // runLandingWake rethrows only a refusal retryableLandingRefusal rejects; the batch keeps a landing fault for adoption.
  const stale = new Refused('POLICY_SNAPSHOT_STALE', 'accepted policy changed during this write; retry the command against current main');
  assert.equal(retryableLandingRefusal(stale.code), true);
  assert.equal(landingFault(stale), true);
  assert.equal(retryableLandingRefusal('LAND_CONFLICT'), false, 'an item defect still parks');
});

test('landing.resource.clause-1-5672-a-lease-renewal: clause 1 (#5672): a lease renewal refused POLICY_SNAPSHOT_STALE retries in a fresh write and succeeds [C7]', async () => {
  let calls = 0;
  const renew = () => {
    calls++;
    if (calls < 3) throw new Refused('POLICY_SNAPSHOT_STALE', 'accepted policy changed during this write; retry the command against current main');
    return 'renewed';
  };
  const waits = [];
  assert.equal(await renewWithBackoff(renew, { pausing: async ms => { waits.push(ms); }, until: () => Date.now() + 120_000 }), 'renewed');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
  await assert.rejects(renewWithBackoff(() => { throw new Refused('LAND_LEASE_LOST', 'lost'); }, { pausing: async () => {} }), { code: 'LAND_LEASE_LOST' });
});

/** A file board whose clock stands `behindMs` behind the wall clock, so a lease taken on it is due `LANDING_LEASE_MS - behindMs` from now. */
function fileBoard(t, behindMs = 0) {
  const { root } = privateFixtureFiles('pullboard-lease-');
  const file = join(root, 'board.sqlite');
  const at = Date.now() - behindMs;
  const board = openCellBoard(file, { now: () => new Date(at) });
  registerSeat(board, { lane: 'coordinator', path: '/renew/main' });
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  return { board, file };
}

/** Take a real landing lease on a board, handing every loss to `onLost`. */
async function lease(board, onLost) {
  return takeLandingResource({ board, branch: 'refs/heads/main', onLost, write: async (operation, args) => store[operation](board, ...args) });
}

test('landing.resource.clause-1-5770-the-guardian-renews: clause 1 (#5770): the guardian renews a held lease heartbeat from its own process and never revives a lapsed or released one [C7]', async t => {
  const { board, file } = fileBoard(t);
  const lost = [];
  const held = await lease(board, error => lost.push(error.code));
  const token = held.fence.token;
  try {
    const before = Date.parse(held.assertCurrent().until);
    const until = renewGuardedHeartbeat(file, token, Date.now() + 60_000);
    assert.ok(until > before, 'the guardian moved the heartbeat past the deadline the lander last renewed');
    assert.equal(Date.parse(store.landingLeaseState(board).holder.until), until, 'the board reads the renewed deadline');
    assert.equal(renewGuardedHeartbeat(file, token, until + 1), null, 'a lapsed heartbeat is never revived');
    assert.equal(renewGuardedHeartbeat(file, '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12)), null, 'another token renews nothing');
  } finally { await held.release(); }
  assert.equal(renewGuardedHeartbeat(file, token), null, 'a released lease is never revived');
  assert.deepEqual(lost, []);
});

test('landing.resource.clause-1-5770-a-lander-whose: clause 1 (#5770): a lander whose event loop missed its renewals keeps the lease its guardian renewed; with no renewal the lease is lost through onLost, never thrown [C7]', async t => {
  // The leases are due 1.5 s and 2 s from now, as if the lander's own 5 s heartbeat had been blocked for nearly 2 minutes.
  const renewed = fileBoard(t, 118_500);
  const kept = [];
  const guarded = await lease(renewed.board, error => kept.push(error.code));
  const starved = fileBoard(t, 118_000);
  let starvedLost;
  const lostOnce = new Promise(resolve => { starvedLost = resolve; });
  const unguarded = await lease(starved.board, error => starvedLost(error.code));
  // The lease's watchdog timers are unref'd, as in the lander; this keeps the test process alive while they run.
  const alive = setInterval(() => {}, 1000);
  try {
    const until = renewGuardedHeartbeat(renewed.file, guarded.fence.token);
    assert.ok(until, 'the guardian renewed the first lease');
    // The watchdog confirms the board's renewed deadline instead of declaring the loss.
    await new Promise(resolve => { const stop = guarded.watchDeadline(at => { if (at === until) { resolve(); queueMicrotask(() => stop()); } }); });
    assert.equal(await lostOnce, 'LAND_LEASE_LOST', 'an unrenewed lease past its deadline is lost through onLost');
    assert.deepEqual(kept, [], 'the renewed lease was kept');
  } finally {
    clearInterval(alive);
    await guarded.release();
    await unguarded.release().catch(() => {});
  }
});
