/** The clock pass applies each due row's registered default move once, logs it as a clock_move event naming the rule, and reports unregistered moves as pending [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { clockSweep } from '../../../index.js';

const MINUTE = 60_000;
/** The store moves the clock pass takes as ports, as the pullboard clock command passes them. */
const PORTS = { listItems: store.listItems, events: store.events, getItem: store.getItem, atomic: store.atomic, logEvent: store.logEvent,
  insertShout: store.insertShout, readBoardMeta: store.readBoardMeta, writeBoardMeta: store.writeBoardMeta, coordinator: 'coordinator' };
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

/** A board at T0 with a ready open item, an idle claim and an item waiting on that claim. */
function fixtureBoard(t) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(T0) });
  const ready = cellItem(board, { lane: 'core', title: 'Ready and unclaimed' }).item_id;
  const claimed = cellItem(board, { lane: 'core', title: 'Claimed and idle' }).item_id;
  const waiting = cellItem(board, { lane: 'core', title: 'Waits on the claim' }).item_id;
  const seat = cellSeat(board, { lane: 'core', path: '/nowhere/clock-sweep' });
  store.claim(board, claimed, { agentId: seat.id, lane: 'core', leaseMs: 600 * MINUTE, freeze: item => ({ text: item.item_title, digest: `private:${item.item_title}` }) });
  board.db.prepare('UPDATE item SET item_after=? WHERE item_id=?').run(String(claimed), waiting);
  return { board, ready, claimed, waiting };
}

/** The clock_move events on one item, with parsed details. */
function clockMoves(board, id) {
  return store.events(board, { itemId: id }).filter(event => event.event_kind === 'clock_move')
    .map(event => ({ by: event.event_by, detail: JSON.parse(event.event_detail) }));
}

test('health.io-clock-sweep.applies-due-moves: clause 1: [B4,C7] one pass applies the registered move of each due item and logs one clock_move naming the rule, reports unregistered moves as pending, and a second pass at the same now applies nothing', t => {
  const { board, ready, claimed, waiting } = fixtureBoard(t);
  const now = T0 + 90 * MINUTE;
  const first = clockSweep(board, { now, ports: PORTS });
  assert.deepEqual(first.applied.map(row => [row.item, row.rule, row.move]), [[ready, 'ready', 'alarm']], 'only the due ready item has a registered move applied');
  assert.deepEqual(first.pending.map(row => [row.item, row.rule, row.move]), [[claimed, 'claim-idle', 'release-claim']], 'the idle claim is due but release-claim has no registered function');
  assert.ok(first.waiting.some(row => row.item === waiting && row.rule === 'waiting'), 'the item behind an unlanded after waits');
  const moves = clockMoves(board, ready);
  assert.equal(moves.length, 1, 'one clock_move per applied move');
  assert.equal(moves[0].by, 'board');
  const { detail } = moves[0];
  assert.equal(detail.rule, 'ready');
  assert.equal(detail.state, 'open, unheld, every after landed, offerable');
  assert.equal(detail.move, 'alarm');
  assert.equal(detail.since, T0);
  assert.equal(detail.deadlineAt, T0 + 60 * MINUTE);
  assert.equal(detail.evidence.kind, 'idle');
  assert.equal(detail.evidence.shout, 'coordinator', 'the alarm shouts the coordinator');
  assert.equal(detail.unknownWaited, false);
  assert.deepEqual(clockMoves(board, claimed), [], 'a pending move is never applied');
  assert.deepEqual(clockMoves(board, waiting), []);
  const second = clockSweep(board, { now, ports: PORTS });
  assert.deepEqual(second.applied, [], 'a second pass at the same now applies nothing');
  assert.equal(clockMoves(board, ready).length, 1, 'still one clock_move after the second pass');
});

test('health.io-clock-sweep.dry-run-writes-nothing: clause 2: [B4,C7] a dry-run pass returns one versioned result with applied, pending and waiting lists and writes no event', t => {
  const { board, ready, claimed } = fixtureBoard(t);
  const count = () => board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  const before = count();
  const result = clockSweep(board, { now: T0 + 90 * MINUTE, dryRun: true, ports: PORTS });
  assert.equal(result.version, 1);
  assert.equal(result.at, new Date(T0 + 90 * MINUTE).toISOString());
  assert.equal(result.dryRun, true);
  for (const list of ['applied', 'pending', 'waiting']) assert.ok(Array.isArray(result[list]), `${list} is a list`);
  assert.deepEqual(result.applied.map(row => row.item), [ready], 'dry-run names the move it would make');
  assert.deepEqual(result.pending.map(row => row.item), [claimed]);
  assert.equal(count(), before, 'dry-run writes no event');
  assert.deepEqual(clockMoves(board, ready), []);
});
