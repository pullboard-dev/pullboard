/** Real SQLite admission, expiry, release and replay controls for landing leases [Q1,Q2,Q3,H16]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { openCellBoard as openBoard } from '../../../store/tests/fixtures/cell.js';
import {
  assertLandingLease,
  guardLandingWrite,
  LANDING_LEASE_MS,
} from '../../../store/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../store/index.js';
import { landingRelayCallbacks } from '../../index.js';

/** Create isolated physical databases sharing an initial board and a controllable receipt clock. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-landing-lease-'));
  let at = Date.parse('2026-10-22T00:00:00.000Z');
  const boards = [0, 1].map(index => openBoard(join(dir, `${index}.sqlite`), { now: () => new Date(at) }));
  store.register(boards[0], { lane: 'coordinator', path: '/private-fixture/coordinator' });
  importBoard(boards[1], exportBoard(boards[0]));
  t.after(() => { for (const board of boards) store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  return { boards, advance(ms) { at += ms; }, now() { return new Date(at).toISOString(); } };
}

/** A real command's request identity, without borrowing any live session or queue token. */
function request() {
  return { agentId: 'coordinator', action: 'request', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
}

test('landing admission is FIFO and stale releases cannot free a successor [Q1,Q2,Q3]', t => {
  const { boards: [board] } = fixture(t);
  const first = request(); const second = request(); const third = request();
  const acquired = store.landingLeaseMove(board, first);
  assert.equal(acquired.acquired, true);
  assert.equal(store.landingLeaseMove(board, second).position, 1);
  assert.equal(store.landingLeaseMove(board, third).position, 2);
  const fence = { ...first, generation: acquired.generation };
  store.landingLeaseMove(board, { ...fence, action: 'bind', guardianPid: process.pid });
  assert.equal(store.landingLeaseState(board).holder.guardianPid, process.pid);
  assert.throws(() => store.landingLeaseMove(board, { ...fence, action: 'bind', guardianPid: process.pid + 1 }), error => error.code === 'LAND_LEASE_REQUEST');
  assert.throws(() => guardLandingWrite(board), error => error.code === 'LAND_LEASE_LOST');
  assert.throws(() => assertLandingLease(board, { ...fence, branch: 'refs/heads/other' }), error => error.code === 'LAND_LEASE_LOST');
  store.landingLeaseMove(board, { ...fence, action: 'release' });
  assert.equal(store.landingLeaseMove(board, third).acquired, false, 'a later poll cannot jump the earlier ticket');
  const next = store.landingLeaseMove(board, second);
  assert.equal(next.acquired, true);
  assert.ok(next.generation > acquired.generation);
  store.landingLeaseMove(board, { ...fence, action: 'release' });
  assert.equal(store.landingLeaseState(board).holder.token, second.token);
  assert.throws(() => store.landingLeaseMove(board, { ...fence, action: 'renew' }), error => error.code === 'LAND_LEASE_LOST');
});

test('a landing lease expires without lending the old holder another grant [Q3]', t => {
  const { boards: [board], advance } = fixture(t);
  const first = request(); const second = request();
  const granted = store.landingLeaseMove(board, first);
  store.landingLeaseMove(board, second);
  advance(LANDING_LEASE_MS - 1000);
  store.landingLeaseMove(board, second); // The live waiter retains its FIFO ticket through the holder's expiry.
  advance(1001);
  const successor = store.landingLeaseMove(board, second);
  assert.equal(successor.acquired, true);
  assert.ok(successor.generation > granted.generation);
  assert.throws(() => assertLandingLease(board, { ...first, generation: granted.generation }), error => error.code === 'LAND_LEASE_LOST');
  assert.throws(() => store.landingLeaseMove(board, { ...first, agentId: 'web-1' }), error => error.code === 'COORDINATOR_ONLY');
});

test('ordered landing admission replays identically and a takeover fences the old invocation [Q1,Q2,H16,E19]', t => {
  const box = fixture(t);
  let sequence = 0;
  /** Replay one exact receipt to both independent replicas, retaining the authenticated coordinator lineage. */
  const move = (operation, options, lineage = 'private-first-lineage') => {
    const prepared = prepareEngineMove(box.boards[0], operation, [options]);
    const position = ++sequence;
    const outcomes = box.boards.map(board => applyEngineMove(board, prepared, { sequence: position, at: box.now(), standing: { root: true, lineage } }));
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(store.landingLeaseState(box.boards[0]), store.landingLeaseState(box.boards[1]));
    return outcomes[0];
  };
  const first = request(); const second = request();
  const acquired = move('landingLeaseMove', first).result;
  assert.equal(acquired.acquired, true);
  assert.equal(move('landingLeaseMove', second).result.position, 1);
  assert.equal(move('landingLeaseMove', second, 'private-other-lineage').error.code, 'COORDINATOR_HELD');
  assert.equal(move('takeCoordinator', { agentId: 'coordinator', machine: 'private-second-machine' }, 'private-other-lineage').error, undefined);
  const oldFence = { ...first, action: 'renew', generation: acquired.generation };
  assert.equal(move('landingLeaseMove', oldFence).error.code, 'COORDINATOR_HELD');
  assert.throws(() => assertLandingLease(box.boards[0], oldFence), error => error.code === 'LAND_LEASE_LOST');
});


test('fenced landing moves never take a local or queued relay fallback [Q1,H16]', () => {
  let applied = 0; let queued = 0;
  const cause = new Error('private relay unavailable');
  const callbacks = { apply() { applied++; return 'local'; }, queue(error, move, apply) { queued++; assert.equal(error, cause); assert.equal(move, 'sealed'); return apply(); } };
  for (const [operation, args] of [['landingLeaseMove', [{}]], ['recordLandingBatch', [{ landingFence: { generation: 1 } }]], ['finishLandingBatch', [{ landingFence: { generation: 1 } }]]]) {
    const guarded = landingRelayCallbacks(operation, args, callbacks);
    assert.throws(guarded.apply, error => error.code === 'LAND_RELAY_REQUIRED');
    assert.throws(() => guarded.queue(cause, 'sealed'), error => error === cause);
  }
  assert.equal(applied, 0); assert.equal(queued, 0);
  const ordinary = landingRelayCallbacks('shout', [{}], callbacks);
  assert.equal(ordinary.apply(), 'local');
  assert.equal(ordinary.queue(cause, 'sealed'), 'local');
  assert.equal(applied, 2); assert.equal(queued, 1);
});
