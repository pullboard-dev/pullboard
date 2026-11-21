/** The hold row's to-rebar move sends a hold past its hard limit to the re-bar queue whatever the evidence, and leaves earlier holds alone [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { clockSweep } from '../../../../index.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const PORTS = { listItems: store.listItems, events: store.events, getItem: store.getItem, atomic: store.atomic, logEvent: store.logEvent,
  insertShout: store.insertShout, readBoardMeta: store.readBoardMeta, writeBoardMeta: store.writeBoardMeta, setItem: store.setItem,
  itemHoldOwner: store.itemHoldOwner, rememberHoldOwner: store.rememberHoldOwner, coordinator: 'coordinator' };

/** A board where one item is held by the coordinator at T0, with an owner and deadline only when asked. */
function heldBoard(t, hold = {}) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(T0) });
  const id = cellItem(board, { lane: 'core', title: 'Held by the coordinator' }).item_id;
  store.holdItem(board, id, { agentId: 'coordinator', reason: 'Private wait for a decision', ...hold });
  return { board, id };
}

/** The clock_move events on one item, with parsed details. */
function clockMoves(board, id) {
  return store.events(board, { itemId: id }).filter(event => event.event_kind === 'clock_move').map(event => JSON.parse(event.event_detail));
}

test('health.io-clock-moves-hold.coordinator-hold-expires: clause 1: [B4,C7] a coordinator hold with no deadline and no evidence goes to the re-bar queue one extra deadline after its first deadline, staying held', t => {
  const { board, id } = heldBoard(t);
  const now = T0 + (1441 + 1440) * MINUTE;
  const pass = clockSweep(board, { now, ports: PORTS });
  assert.deepEqual(pass.applied.map(row => [row.item, row.rule, row.move]), [[id, 'hold', 'to-rebar']]);
  const item = store.getItem(board, id);
  assert.equal(item.item_hold_reason, 're-bar: Private wait for a decision', 'the original text is kept under the re-bar prefix');
  assert.ok(item.item_hold_by, 'the item stays held');
  const owner = store.itemHoldOwner(board, id);
  assert.equal(owner.owner, 're-bar-queue');
  assert.equal(owner.deadline, new Date(now + 1440 * MINUTE).toISOString(), 'a fresh deadline a day out');
  const moves = clockMoves(board, id);
  assert.equal(moves.length, 1, 'one clock_move');
  assert.equal(moves[0].rule, 'hold');
  assert.equal(moves[0].move, 'to-rebar');
  assert.equal(clockSweep(board, { now, ports: PORTS }).applied.length, 0, 'a second pass at the same now moves nothing');
  assert.equal(clockMoves(board, id).length, 1);
});

test('health.io-clock-moves-hold.before-limit-unchanged: clause 2: [B4,C7] a hold at 1439 min, and a hold with a recorded deadline still in the future, are unchanged', t => {
  const early = heldBoard(t);
  clockSweep(early.board, { now: T0 + 1439 * MINUTE, ports: PORTS });
  assert.equal(store.getItem(early.board, early.id).item_hold_reason, 'Private wait for a decision');
  assert.deepEqual(clockMoves(early.board, early.id), []);
  const recorded = heldBoard(t, { owner: 'coordinator', deadline: new Date(T0 + 4000 * MINUTE).toISOString() });
  const pass = clockSweep(recorded.board, { now: T0 + 2881 * MINUTE, ports: PORTS });
  assert.deepEqual(pass.applied, [], 'a recorded deadline in the future moves nothing');
  assert.equal(store.getItem(recorded.board, recorded.id).item_hold_reason, 'Private wait for a decision');
  assert.deepEqual(clockMoves(recorded.board, recorded.id), []);
});
