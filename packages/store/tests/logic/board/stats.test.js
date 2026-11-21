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

/** Every SELECT a call prepares on the board's connection, with its query plan rows. */
function plannedStatements(board, run) {
  const prepare = board.db.prepare.bind(board.db), seen = [];
  board.db.prepare = sql => { seen.push(sql); return prepare(sql); };
  try { run(); } finally { board.db.prepare = prepare; }
  return seen.filter(sql => /^\s*SELECT/iu.test(sql)).map(sql => ({ sql, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail) }));
}

/** Give a seat `count` earlier events of other kinds, written as the board's own rows. */
function seatHistory(board, seat, count) {
  const event = board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const now = board.clock.now().getTime();
  board.db.exec('BEGIN');
  try { for (let index = 0; index < count; index += 1) event.run(new Date(now - 3_600_000 + index).toISOString(), seat, index % 2 ? 'heartbeat' : 'fact', null, '{}'); board.db.exec('COMMIT'); }
  catch (error) { board.db.exec('ROLLBACK'); throw error; }
}

/** The median milliseconds of an idle record that finds the seat's answer unchanged, each sample a batch of calls. */
function unchangedIdleMs(board, seat, samples = 20, batch = 10) {
  const observation = { agentId: seat, reason: 'nothing-eligible' };
  store.board_recordNextIdle(board, observation);
  const times = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    for (let call = 0; call < batch; call += 1) assert.equal(store.board_recordNextIdle(board, observation).unchanged, true);
    times.push((performance.now() - started) / batch);
  }
  return times.sort((a, b) => a - b)[Math.floor(samples / 2)];
}

test('store.logic-board-stats.idle-check-seeks-latest-event: clause 1: the idle check reads a seat\'s latest event with one index seek, never sorting or scanning the seat\'s events [C7]', (t) => {
  const board = cellBoard(t, ':memory:');
  const seat = cellSeat(board, { lane: 'core', path: '/fixture/core-1' }).id;
  seatHistory(board, seat, 50);
  store.board_recordNextIdle(board, { agentId: seat, reason: 'nothing-eligible' });
  const statements = plannedStatements(board, () => store.board_recordNextIdle(board, { agentId: seat, reason: 'nothing-eligible' }));
  const eventReads = statements.filter(({ sql }) => /\bFROM event\b/u.test(sql));
  assert.ok(eventReads.some(({ sql }) => /ORDER BY event_id DESC/u.test(sql)), 'the idle check reads the seat\'s latest event');
  for (const { sql, plan } of eventReads) {
    assert.ok(!plan.some(detail => /USE TEMP B-TREE/u.test(detail)), `an idle read sorts events: ${sql} -> ${plan.join('; ')}`);
    assert.ok(!plan.some(detail => /^SCAN event\b/u.test(detail)), `an idle read scans events: ${sql} -> ${plan.join('; ')}`);
  }
});

test('store.logic-board-stats.idle-check-flat-with-history: clause 2: with 18,187 earlier events on the seat, an unchanged idle record stays under 200 ms and within 2x of a seat with 10 [C7]: 1:10 of the coordinator\'s live history', (t) => {
  const board = cellBoard(t, ':memory:');
  const small = cellSeat(board, { lane: 'core', path: '/fixture/core-1' }).id;
  const large = cellSeat(board, { lane: 'core', path: '/fixture/core-2' }).id;
  seatHistory(board, small, 10);
  seatHistory(board, large, 18_187);
  unchangedIdleMs(board, small, 3, 3); unchangedIdleMs(board, large, 3, 3);
  const base = unchangedIdleMs(board, small);
  const loaded = unchangedIdleMs(board, large);
  assert.ok(loaded < 200, `median ${loaded.toFixed(3)} ms with history`);
  assert.ok(loaded <= Math.max(2 * base, base + 0.1), `median ${loaded.toFixed(3)} ms with history against ${base.toFixed(3)} ms with 10 events`);
});
