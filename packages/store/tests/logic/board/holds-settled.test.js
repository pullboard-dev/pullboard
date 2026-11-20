/** A hold is settled once every item its reason names is done, and a parent once all children are [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settledHoldReason } from '../../../src/logic/board/holds.js';
import { parentHoldSettled } from '../../../src/logic/board/holds.js';
import { rebarHoldReason } from '../../../src/logic/board/holds.js';
import { liftSettledHolds } from '../../../src/logic/board/holds.js';
import { dependentsOf } from '../../../src/logic/board/holds.js';
import { flagWithdrawnDependents } from '../../../src/logic/board/holds.js';

const statuses = { 1: 'landed', 2: 'withdrawn', 3: 'open', 4: 'landed' };
const statusOf = id => statuses[id];

test('store.logic-board-holds-settled.settledholdreason-is-true-only-when-it: clause 1: settledHoldReason is true only when it names an item and every named item is landed or withdrawn [C7]', () => {
  assert.equal(settledHoldReason('waiting on #1', statusOf), true);
  assert.equal(settledHoldReason('after #1 and #2, also #1 again', statusOf), true);
  assert.equal(settledHoldReason('after #1 and #3', statusOf), false);
});

test('store.logic-board-holds-settled.a-reason-naming-an-open-item: clause 2: a reason naming an open item, or no item, is not settled [C7]', () => {
  assert.equal(settledHoldReason('waiting on #3', statusOf), false);
  assert.equal(settledHoldReason('waiting on the person', statusOf), false);
  assert.equal(settledHoldReason('', statusOf), false);
  assert.equal(settledHoldReason(null, statusOf), false);
  assert.equal(settledHoldReason('see #99', statusOf), false);
});

test('store.logic-board-holds-settled.parentholdsettled-needs-at-least-one-child: clause 3: parentHoldSettled needs at least one child and every child landed or withdrawn [C7]', () => {
  assert.equal(parentHoldSettled(['landed', 'withdrawn']), true);
  assert.equal(parentHoldSettled(['landed', 'open']), false);
  assert.equal(parentHoldSettled([]), false);
});

test('store.logic-board-holds-settled.withdrawn-to-rebar: clause 1: rebarHoldReason returns re-bar text keeping the original when a reason names a withdrawn item and only done items, else null [C7]', () => {
  assert.equal(rebarHoldReason('waiting on #2', statusOf), 're-bar: waiting on #2');
  assert.equal(rebarHoldReason('after #1 and #2', statusOf), 're-bar: after #1 and #2');
  assert.equal(rebarHoldReason('re-bar: waiting on #2', statusOf), 're-bar: waiting on #2');
  assert.equal(rebarHoldReason('waiting on #1', statusOf), null);
  assert.equal(rebarHoldReason('after #2 and #3', statusOf), null);
  assert.equal(rebarHoldReason('waiting on the person', statusOf), null);
  assert.equal(rebarHoldReason(null, statusOf), null);
});

test('store.logic-board-holds-settled.withdraw-event-rebars-hold: clause 2: liftSettledHolds rewrites a hold naming a withdrawn item to re-bar text on a withdraw event, logs it and lifts the landed-only hold [C7]', () => {
  const items = { 1: { item_status: 'open', item_merged_commit: 'abc' }, 2: { item_status: 'withdrawn', item_merged_commit: null } };
  const held = [{ item_id: 10, item_hold_reason: 'waiting on #2' }, { item_id: 11, item_hold_reason: 'waiting on #1' }, { item_id: 12, item_hold_reason: 'waiting on #9' }];
  const board = { liftSettledHolds: true, db: { prepare: sql => ({
    get: id => items[id],
    all: id => (sql.includes('item_hold_reason IS NOT NULL') ? held : id === undefined ? [] : []),
    run: () => ({}),
  }) } };
  const patches = [];
  const logged = [];
  const setItem = (_board, id, patch) => patches.push({ id, patch });
  const logEvent = (_board, by, kind, id, detail) => logged.push({ kind, id, detail });
  liftSettledHolds(board, { event_id: 7, event_kind: 'withdraw', item_id: 2, event_at: '2026-11-20T00:00:00.000Z' }, logEvent, setItem);
  assert.deepEqual(patches.find(p => p.id === 10), { id: 10, patch: { item_hold_reason: 're-bar: waiting on #2' } });
  assert.deepEqual(logged.find(l => l.id === 10), { kind: 'hold_item', id: 10, detail: { reason: 're-bar: waiting on #2', cause: 'withdrawn-dependency', triggerEventId: 7 } });
  assert.deepEqual(patches.find(p => p.id === 11).patch, { item_hold_reason: null, item_hold_by: null, item_hold_at: null });
  assert.equal(logged.find(l => l.id === 11).kind, 'unhold_item');
  assert.equal(patches.some(p => p.id === 12), false);
});

const dependentRows = [
  { item_id: 20, item_status: 'open', item_after: '2,5' },
  { item_id: 21, item_status: 'claimed', item_after: '7,2' },
  { item_id: 22, item_status: 'withdrawn', item_after: '2' },
  { item_id: 23, item_status: 'open', item_after: '2', item_merged_commit: 'abc' },
  { item_id: 24, item_status: 'open', item_after: '12' },
  { item_id: 25, item_status: 'open', item_after: '' },
];

test('store.logic-board-holds-settled.withdraw-flags-dependents: clause 1: dependentsOf names open items waiting on an id and flagWithdrawnDependents logs one dependency_withdrawn event per open dependent, none for landed or withdrawn ones [C7]', () => {
  assert.deepEqual(dependentsOf(dependentRows, 2), [20, 21]);
  assert.deepEqual(dependentsOf(dependentRows, 99), []);
  const logged = [];
  const board = { db: { prepare: () => ({ all: () => dependentRows }) } };
  flagWithdrawnDependents(board, { event_id: 8, event_kind: 'withdraw', item_id: 2 }, (_board, by, kind, id, detail) => logged.push({ by, kind, id, detail }));
  assert.deepEqual(logged, [
    { by: 'coordinator', kind: 'dependency_withdrawn', id: 20, detail: { withdrawn: 2, triggerEventId: 8 } },
    { by: 'coordinator', kind: 'dependency_withdrawn', id: 21, detail: { withdrawn: 2, triggerEventId: 8 } },
  ]);
  flagWithdrawnDependents(board, { event_id: 9, event_kind: 'merged', item_id: 2 }, () => assert.fail('only a withdraw event flags'));
});

test('store.logic-board-holds-settled.withdraw-event-flags: clause 2: flagWithdrawnDependents runs from the event log beside liftSettledHolds on a withdraw event whatever holds.liftSettled says, with a stub board and logEvent [C7]', () => {
  const logged = [];
  const board = { liftSettledHolds: false, db: { prepare: () => ({ all: () => dependentRows, get: () => undefined, run: () => ({}) }) } };
  const logEvent = (_board, by, kind, id) => logged.push({ kind, id });
  const event = { event_id: 10, event_kind: 'withdraw', item_id: 2, event_at: '2026-11-20T00:00:00.000Z' };
  liftSettledHolds(board, event, logEvent, () => assert.fail('off setting writes nothing'));
  flagWithdrawnDependents(board, event, logEvent);
  assert.deepEqual(logged.map(row => row.id), [20, 21]);
});
