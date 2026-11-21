/** next's cooldown and pairing reads seek a seat's events of one kind and never walk the seat's whole history [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ineligibleReleaseIds } from '../../src/io/cooldown.js';
import { parkedClaims } from '../../src/io/cooldown.js';
import { refusesFamilyRelaxation } from '../../src/io/board/next-refused-pairings.js';
import { cellBoard } from '../fixtures/cell.js';
import { cellSeat } from '../fixtures/cell.js';

const READS = { ineligibleReleaseIds, parkedClaims, refusesFamilyRelaxation };

/** Every SELECT a call prepares on the board's connection, with its query plan rows. */
function plannedStatements(board, run) {
  const prepare = board.db.prepare.bind(board.db), seen = [];
  board.db.prepare = sql => { seen.push(sql); return prepare(sql); };
  try { run(); } finally { board.db.prepare = prepare; }
  return seen.filter(sql => /^\s*SELECT/iu.test(sql)).map(sql => ({ sql, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail) }));
}

/** A seat with `history` events of other kinds and five review releases, written as the board's own rows. */
function seatWithHistory(board, path, history) {
  const seat = cellSeat(board, { lane: 'core', path }).id;
  const event = board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const now = board.clock.now().getTime();
  board.db.exec('BEGIN');
  try {
    for (let index = 0; index < history; index += 1) event.run(new Date(now - 3_600_000 + index).toISOString(), seat, index % 2 ? 'heartbeat' : 'fact', null, '{}');
    for (let index = 0; index < 5; index += 1) event.run(new Date(now - 1_000 + index).toISOString(), seat, 'release', null, JSON.stringify({ reasonCode: 'INELIGIBLE', review: true }));
    board.db.exec('COMMIT');
  } catch (error) { board.db.exec('ROLLBACK'); throw error; }
  return seat;
}

/** The median milliseconds of one read, each sample a batch of calls so a sub-millisecond read still measures. */
function medianMs(read, board, seat, samples = 20, batch = 20) {
  const times = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    for (let call = 0; call < batch; call += 1) read(board, seat);
    times.push((performance.now() - started) / batch);
  }
  return times.sort((a, b) => a - b)[Math.floor(samples / 2)];
}

test('store.io-cooldown.seat-kind-reads-seek: clause 1: the release and pairing reads seek a seat\'s events by seat and kind, never scanning events, every kind\'s events or the seat\'s history by time [C7]', (t) => {
  const board = cellBoard(t, ':memory:');
  const seat = seatWithHistory(board, '/fixture/core-1', 50);
  for (const [name, read] of Object.entries(READS)) {
    const statements = plannedStatements(board, () => read(board, seat));
    assert.ok(statements.some(({ sql }) => /\bevent\b/u.test(sql)), `${name} reads events`);
    for (const { sql, plan } of statements) {
      assert.ok(!plan.some(detail => /^SCAN (event|e)\b/u.test(detail)), `${name} scans events: ${sql} -> ${plan.join('; ')}`);
      assert.ok(!plan.some(detail => /INDEX event_by_at\b/u.test(detail)), `${name} walks the seat's events by time: ${sql} -> ${plan.join('; ')}`);
      if (/\bevent_by\s*=/u.test(sql) && /\bevent_kind\s*=/u.test(sql) && !/\bitem_id\s*=\s*\?/u.test(sql)) assert.ok(plan.some(detail => /INDEX event_by_kind_id\b/u.test(detail)), `${name} does not seek by seat and kind: ${sql} -> ${plan.join('; ')}`);
    }
  }
});

test('store.io-cooldown.cooldown-flat-with-history: clause 2: with 18,187 events of other kinds on the seat, each read stays under 20 ms and within 2x of a seat with 10 [C7]: 1:10 of the coordinator\'s live history', (t) => {
  const board = cellBoard(t, ':memory:');
  const small = seatWithHistory(board, '/fixture/core-1', 10);
  const large = seatWithHistory(board, '/fixture/core-2', 18_187);
  for (const [name, read] of Object.entries(READS)) {
    medianMs(read, board, small, 3, 5); medianMs(read, board, large, 3, 5);
    const base = medianMs(read, board, small);
    const loaded = medianMs(read, board, large);
    assert.ok(loaded < 20, `${name}: median ${loaded.toFixed(3)} ms with history`);
    assert.ok(loaded <= Math.max(2 * base, base + 0.05), `${name}: median ${loaded.toFixed(3)} ms with history against ${base.toFixed(3)} ms with 10 events`);
  }
});
