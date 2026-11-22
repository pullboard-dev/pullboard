/** @pullboard-test-input packages/store/src/logic/board/landing/lease.js packages/store/src/logic/board/landing/in-flight.js packages/moves/src/logic/table/lease.table.js */
/** The store landing lease door persists in-flight batches using the moves table's allowance [C7,#11247]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../../../store/index.js';
import { inFlightBatches } from '../../../../../../store/src/logic/board/landing/in-flight.js';
import { cellBoard } from '../../../../fixtures/cell-board.js';

const AT = Date.parse('2026-11-16T12:00:00.000Z');

/** Acquire a lease on a fixture board and return its identity. */
function heldLease(t) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  const lease = { agentId: 'coordinator', token: randomUUID(), branch: 'main', pid: 100 };
  const requested = store.landingLeaseMove(board, { ...lease, action: 'request' });
  return { board, lease, requested };
}

test('board.from-store-landing-lease.batch-persists-and-lists-two-in-flight: clause 1: batch moves with allowance 2 persist both batches and inFlightBatches reads them [C7,#11247]', t => {
  const { board, lease, requested } = heldLease(t);
  for (const batch of ['first', 'second']) {
    store.landingLeaseMove(board, { ...lease, action: 'batch', batch, allowance: 2, generation: requested.generation });
  }
  const saved = JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('landing_lease').meta_value);
  assert.deepEqual(saved.batches, ['first', 'second']);
  assert.deepEqual(inFlightBatches(store.landingLeaseState(board)), ['first', 'second']);
});

test('board.from-store-landing-lease.allowance-refusal-and-release-clear: clause 2: a full allowance refuses another batch without changes, release clears batches, and request renew bind release work [C7,#11247]', t => {
  const { board, lease, requested } = heldLease(t);
  assert.equal(requested.acquired, true);
  const holder = store.landingLeaseState(board).holder;
  const renewed = store.landingLeaseMove(board, { ...lease, action: 'renew', generation: holder.generation });
  assert.equal(renewed.holder.token, lease.token);
  const bound = store.landingLeaseMove(board, { ...lease, action: 'bind', generation: holder.generation, guardianPid: 101 });
  assert.equal(bound.holder.guardianPid, 101);
  store.landingLeaseMove(board, { ...lease, action: 'batch', batch: 'first', allowance: 1, generation: holder.generation });
  assert.throws(() => store.landingLeaseMove(board, { ...lease, action: 'batch', batch: 'second', generation: holder.generation }), error => {
    assert.equal(error.code, 'LAND_LEASE_REQUEST');
    return true;
  });
  assert.deepEqual(inFlightBatches(store.landingLeaseState(board)), ['first']);
  const released = store.landingLeaseMove(board, { ...lease, action: 'release', generation: holder.generation });
  assert.equal(released.holder, null);
  assert.deepEqual(inFlightBatches(store.landingLeaseState(board)), []);
});
