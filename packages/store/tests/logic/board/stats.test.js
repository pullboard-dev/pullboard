/** recordNextIdle also records a next call that timed out and a seat that finished its loop, once per seat [N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';

/** The seat's events of one kind, with their parsed detail. */
function eventsOf(board, kind) {
  return board.db.prepare('SELECT event_by, event_detail FROM event WHERE event_kind=? ORDER BY event_id').all(kind)
    .map(row => ({ by: row.event_by, detail: JSON.parse(row.event_detail) }));
}

test('store.logic-board-stats.idle-timeout-event: clause 1: recordNextIdle on a joined seat with a timeout observation writes one next-idle-timeout event carrying version, engine, lane, minutes and awaited [N2]', t => {
  const board = cellBoard(t, ':memory:');
  const seat = cellSeat(board, { lane: 'core', path: '/fixture/core-1' }).id;
  assert.deepEqual(store.board_recordNextIdle(board, { agentId: seat, timeout: { minutes: 45, awaited: 'a free item in the core lane' } }), { recorded: true });
  const rows = eventsOf(board, 'next-idle-timeout');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].by, seat);
  assert.deepEqual(Object.keys(rows[0].detail).filter(key => key !== 'model').sort(), ['awaited', 'engine', 'lane', 'minutes', 'version']);
  assert.equal(rows[0].detail.version, 1);
  assert.equal(rows[0].detail.lane, 'core');
  assert.equal(rows[0].detail.minutes, 45);
  assert.equal(rows[0].detail.awaited, 'a free item in the core lane');
  assert.equal(typeof rows[0].detail.engine, 'number');
  assert.throws(() => store.board_recordNextIdle(board, { agentId: seat, timeout: { minutes: 'long', awaited: 'x' } }), error => error?.code === 'BAD_IDLE_TIMEOUT');
  assert.equal(eventsOf(board, 'next-idle-timeout').length, 1, 'a refused observation writes nothing');
});

test('store.logic-board-stats.finished-once: clause 2: recordNextIdle with a finished observation writes one next-finished event per seat however many times it is called, and an unjoined seat is refused NOT_JOINED [N2]', t => {
  const board = cellBoard(t, ':memory:');
  const first = cellSeat(board, { lane: 'core', path: '/fixture/core-1' }).id;
  const second = cellSeat(board, { lane: 'core', path: '/fixture/core-2' }).id;
  store.board_recordNextIdle(board, { agentId: first, finished: true });
  store.board_recordNextIdle(board, { agentId: first, finished: true });
  assert.deepEqual(eventsOf(board, 'next-finished').map(row => row.by), [first], 'two calls from one seat write one event');
  store.board_recordNextIdle(board, { agentId: second, finished: true });
  assert.deepEqual(eventsOf(board, 'next-finished').map(row => row.by), [first, second], 'each seat has its own');
  assert.equal(eventsOf(board, 'next-finished')[0].detail.lane, 'core');
  assert.throws(() => store.board_recordNextIdle(board, { agentId: 'ghost-9', finished: true }), error => error?.code === 'NOT_JOINED');
});
