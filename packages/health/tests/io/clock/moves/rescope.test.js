/** The rescope row's to-person move holds a stale re-scope release for the person, and leaves a young or cleared one alone [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';
import { clockSweep } from '../../../../index.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const PORTS = { listItems: store.listItems, events: store.events, getItem: store.getItem, atomic: store.atomic, logEvent: store.logEvent,
  insertShout: store.insertShout, readBoardMeta: store.readBoardMeta, writeBoardMeta: store.writeBoardMeta, setItem: store.setItem,
  itemHoldOwner: store.itemHoldOwner, rememberHoldOwner: store.rememberHoldOwner, holdItem: store.holdItem,
  allItemsNeedingRescope: store.allItemsNeedingRescope, coordinator: 'coordinator' };

/** A board with one open item that a seat released as INELIGIBLE `age` minutes before T0, with an edit event after it only when asked. */
function rescopeBoard(t, age, { edited = false } = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(T0) });
  const seat = cellSeat(board, { lane: 'core', path: '/fixture/core-rescope' }).id;
  const id = cellItem(board, { lane: 'core', title: 'Hidden by a re-scope release' }).item_id;
  const event = board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  event.run(new Date(T0 - age * MINUTE).toISOString(), seat, 'release', id, JSON.stringify({ reasonCode: 'INELIGIBLE', reason: 'too big for one seat' }));
  if (edited) event.run(new Date(T0 - (age - 1) * MINUTE).toISOString(), 'coordinator', 'edit', id, '{}');
  return { board, id, seat };
}

/** The clock_move events on one item, with parsed details. */
function clockMoves(board, id) {
  return store.events(board, { itemId: id }).filter(event => event.event_kind === 'clock_move').map(event => JSON.parse(event.event_detail));
}

test('health.io-clock-moves-rescope.to-person-list: clause 1: [B4,C7] a re-scope release 121 min old with no later edit is held for the person with a day deadline and a reason quoting the release, listed by hold --list --owner person', t => {
  const { board, id, seat } = rescopeBoard(t, 121);
  const pass = clockSweep(board, { now: T0, ports: PORTS });
  assert.deepEqual(pass.applied.map(row => [row.item, row.rule, row.move]), [[id, 'rescope', 'to-person']]);
  const item = store.getItem(board, id);
  assert.ok(item.item_hold_by, 'the item is held');
  assert.match(item.item_hold_reason, new RegExp(`${seat}: INELIGIBLE \\(too big for one seat\\), released 121 min ago`), 'the reason quotes seat, code, text and age');
  const owner = store.itemHoldOwner(board, id);
  assert.equal(owner.owner, 'person');
  assert.equal(owner.deadline, new Date(T0 + 1440 * MINUTE).toISOString(), 'a deadline a day out');
  const listed = store.listItems(board).filter(each => store.itemHoldOwner(board, each.item_id)?.owner === 'person').map(each => each.item_id);
  assert.deepEqual(listed, [id], 'hold --list --owner person reads this record');
  const moves = clockMoves(board, id);
  assert.equal(moves.length, 1, 'one clock_move');
  assert.equal(moves[0].rule, 'rescope');
  assert.equal(clockSweep(board, { now: T0, ports: PORTS }).applied.length, 0, 'a second pass moves nothing');
  const later = clockSweep(board, { now: T0 + 3 * 1440 * MINUTE, ports: PORTS });
  assert.deepEqual(later.applied, [], 'the clock never moves a person-owned hold, however old');
  assert.equal(store.itemHoldOwner(board, id).owner, 'person');
  assert.equal(clockMoves(board, id).length, 1);
});

test('health.io-clock-moves-rescope.cleared-or-early: clause 2: [B4,C7] the same release at 119 min, or with a later edit event, is not moved', t => {
  for (const { board, id } of [rescopeBoard(t, 119), rescopeBoard(t, 121, { edited: true })]) {
    const pass = clockSweep(board, { now: T0, ports: PORTS });
    assert.deepEqual(pass.applied.filter(row => row.rule === 'rescope'), []);
    assert.equal(store.getItem(board, id).item_hold_by, null, 'the item is not held');
    assert.equal(store.itemHoldOwner(board, id), null);
    assert.deepEqual(clockMoves(board, id).filter(move => move.rule === 'rescope'), []);
  }
});
