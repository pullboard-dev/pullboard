/** In-memory engine replay coverage for sealed review-skipped snapshots [Q1,V15,H3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';

const CLAIM_AT = '2026-10-08T12:00:00.000Z';
const RENEW_AT = '2026-10-08T12:00:30.000Z';
const LEASE_MS = 60_000;
const REVIEW_SKIPPED = {
  offeredItem: 9,
  ratio: 0.5,
  pending: 3,
  reviewing: 1,
  reserved: 0,
  oldestSubmittedAt: '2026-10-08T11:00:00.000Z',
  ageMs: 3_600_000,
};

/** Create one seed board and two independent in-memory replicas with different ambient clocks. */
function memoryCopies(t) {
  const source = store.openBoard(':memory:', { now: () => new Date('2026-10-08T10:00:00.000Z') });
  store.register(source, { lane: 'coordinator', path: '/fixture' });
  store.register(source, { lane: 'web', path: '/fixture/web-1' });
  store.register(source, { lane: 'web', path: '/fixture/web-2' });
  const item = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Review queue fixture' });
  const snapshot = exportBoard(source);
  const copies = ['one', 'two'].map((name, index) => {
    const clock = { now: () => new Date(`2026-10-08T${String(index + 8).padStart(2, '0')}:00:00.000Z`) };
    const board = store.openBoard(':memory:', clock);
    importBoard(board, snapshot);
    return board;
  });
  t.after(() => {
    for (const board of copies) store.closeBoard(board);
    store.closeBoard(source);
  });
  return { source, copies, item };
}

/** Seal one deterministic claim with the supplied review queue snapshot. */
function claimMove(board, item, agentId, id, reviewSkipped = REVIEW_SKIPPED) {
  return prepareEngineMove(board, 'claim', [item, {
    agentId,
    lane: 'web',
    leaseMs: LEASE_MS,
    head: 'a'.repeat(40),
    freeze: () => ({ text: 'the exact review queue criterion', digest: 'f'.repeat(64) }),
    reviewSkipped,
  }], { id });
}

/** Read committed event rows from a native in-memory board. */
function eventRows(board) {
  return store.events(board);
}

test('review-skip semantics seal after released engine 1, accept legacy claims and refuse future engines before mutation [Q1,V15,H16]', (t) => {
  const { copies: [one], item } = memoryCopies(t);
  const fresh = claimMove(one, item, 'web-1', 'new-engine');
  assert.ok(fresh.engine >= 2, 'released engine 1 cannot silently ignore the new claim snapshot');
  assert.equal(fresh.engine, ENGINE_VERSION);
  const legacy = { ...claimMove(one, item, 'web-1', 'legacy-engine', null), engine: 1 };
  const accepted = applyEngineMove(one, legacy, { sequence: 1, at: CLAIM_AT });
  assert.equal(Boolean(accepted.error), false, 'legacy engine-1 claims remain executable');
  assert.equal(accepted.events[0].event_kind, 'claim');
  assert.equal(Object.hasOwn(JSON.parse(accepted.events[0].event_detail), 'reviewSkipped'), false);
  const before = exportBoard(one);
  assert.throws(() => applyEngineMove(one, { ...fresh, engine: ENGINE_VERSION + 1 }, { sequence: 2, at: RENEW_AT }), (error) => {
    assert.equal(error.code, 'ENGINE_VERSION');
    assert.match(error.message, new RegExp(`engine version ${ENGINE_VERSION + 1}.*engine version ${ENGINE_VERSION}`));
    assert.match(error.message, /upgrade pullboard/);
    return true;
  });
  assert.deepEqual(exportBoard(one), before, 'future-engine refusal preserves all rows and the replay cursor');
});

test('sealed review-skip claims replay identically, while renewals and refusals add no skipped claim [Q1,V15,H3,H16]', (t) => {
  const { copies: [one, two], item } = memoryCopies(t);
  const freshOne = claimMove(one, item, 'web-1', 'queue-claim');
  const freshTwo = claimMove(two, item, 'web-1', 'queue-claim');
  assert.deepEqual(freshOne, freshTwo, 'both replicas seal the same offered-item and queue snapshot');

  const first = applyEngineMove(one, freshOne, { sequence: 1, at: CLAIM_AT });
  const second = applyEngineMove(two, freshTwo, { sequence: 1, at: CLAIM_AT });
  assert.deepEqual(first, second);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].event_kind, 'claim');
  assert.deepEqual(JSON.parse(first.events[0].event_detail).reviewSkipped, REVIEW_SKIPPED);
  assert.deepEqual(exportBoard(one), exportBoard(two), 'fixed engine time gives identical item, events and metadata');

  const eventCount = eventRows(one).length;
  const samePosition = applyEngineMove(one, freshOne, { sequence: 1, at: CLAIM_AT });
  assert.deepEqual(samePosition, first);
  const duplicateId = applyEngineMove(one, freshOne, { sequence: 2, at: CLAIM_AT });
  assert.deepEqual(duplicateId, first, 'a later position with the same id reuses its first outcome');
  assert.equal(eventRows(one).length, eventCount, 'duplicate ids append neither another claim nor another skip');
  const duplicateReplica = applyEngineMove(two, freshTwo, { sequence: 2, at: CLAIM_AT });
  assert.deepEqual(duplicateReplica, first);
  assert.deepEqual(exportBoard(one), exportBoard(two));

  const renewOne = claimMove(one, item, 'web-1', 'queue-renew');
  const renewTwo = claimMove(two, item, 'web-1', 'queue-renew');
  const renewedOne = applyEngineMove(one, renewOne, { sequence: 3, at: RENEW_AT });
  const renewedTwo = applyEngineMove(two, renewTwo, { sequence: 3, at: RENEW_AT });
  assert.deepEqual(renewedOne, renewedTwo);
  assert.equal(renewedOne.events[0].event_kind, 'renew');
  assert.equal(Object.hasOwn(JSON.parse(renewedOne.events[0].event_detail), 'reviewSkipped'), false, 'renewal details omit the stale selection snapshot');
  assert.deepEqual(exportBoard(one), exportBoard(two));

  const beforeRefusal = eventRows(one).length;
  const refusedOne = applyEngineMove(one, claimMove(one, item, 'web-2', 'queue-refused'), { sequence: 4, at: RENEW_AT });
  const refusedTwo = applyEngineMove(two, claimMove(two, item, 'web-2', 'queue-refused'), { sequence: 4, at: RENEW_AT });
  assert.deepEqual(refusedOne, refusedTwo);
  assert.equal(refusedOne.error.code, 'HELD');
  assert.equal(eventRows(one).length, beforeRefusal, 'a refused claim cannot append a claim or skipped-review event');
  assert.deepEqual(exportBoard(one), exportBoard(two));
});
