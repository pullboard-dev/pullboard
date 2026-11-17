/** The max-agents series prints per-hour landings and active seats from board events, read only and rerunnable [C7,#9450,#2218]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readMaxAgentsSeries } from '../../index.js';
import { maxAgentsLines } from '../../index.js';

const SINCE = '2026-11-01T00:00:00.000Z';
const UNTIL = '2026-11-01T04:00:00.000Z';

/** A seeded board: hour 0 lands 1 with 1 seat, hour 1 lands 4 with 3 seats, hour 2 lands 4 with 5 seats, hour 3 lands 1. */
function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_kind TEXT NOT NULL, event_by TEXT, item_id INTEGER, event_at TEXT NOT NULL)');
  const put = (kind, by, at) => db.prepare('INSERT INTO event (event_kind, event_by, item_id, event_at) VALUES (?, ?, 1, ?)').run(kind, by, at);
  put('claim', 'core-1', '2026-11-01T00:10:00.000Z'); put('merged', 'board', '2026-11-01T00:20:00.000Z');
  for (const [seat, minute] of [['core-1', 5], ['core-2', 6], ['core-3', 7]]) put('claim', seat, `2026-11-01T01:0${minute % 10}:00.000Z`);
  for (let i = 0; i < 4; i += 1) put('merged', 'board', `2026-11-01T01:3${i}:00.000Z`);
  for (const seat of ['core-1', 'core-2', 'core-3', 'core-4', 'core-5']) put('claim', seat, '2026-11-01T02:05:00.000Z');
  for (let i = 0; i < 4; i += 1) put('merged', 'board', `2026-11-01T02:4${i}:00.000Z`);
  put('merged', 'board', '2026-11-01T03:30:00.000Z');
  put('merged', 'board', '2026-11-01T05:30:00.000Z');
  return db;
}

test('stats.max-agents-series.the-series-prints-per-hour-landings: clause 1: the series prints per-hour landings and active seats, the plateau and the hours at it, identical on two runs [C7,#9450]', () => {
  const db = seeded();
  const first = readMaxAgentsSeries(db, { since: SINCE, until: UNTIL });
  const second = readMaxAgentsSeries(db, { since: SINCE, until: UNTIL });
  assert.deepEqual(first.hours.map(row => [row.landings, row.activeSeats]), [[1, 1], [4, 3], [4, 5], [1, 0]]);
  assert.equal(first.plateau, 4);
  assert.equal(first.plateauHours, 2);
  assert.equal(first.plateauSeats, 3);
  assert.deepEqual(second, first);
  assert.deepEqual(maxAgentsLines(second), maxAgentsLines(first));
  assert.match(maxAgentsLines(first).join('\n'), /plateau 4 landings per hour, reached with 3 active seats, 2 hours at the plateau/u);
});

test('stats.max-agents-series.the-series-is-read-only-and: clause 2: the series is read-only and prints the exact command line that reproduces it [C7,#9450]', () => {
  const db = seeded();
  const before = db.prepare('SELECT COUNT(*) AS n, MAX(event_id) AS last FROM event').get();
  const series = readMaxAgentsSeries(db, { since: SINCE, until: UNTIL });
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n, MAX(event_id) AS last FROM event').get(), before);
  assert.equal(series.command, `pullboard stats max-agents --since ${SINCE} --until ${UNTIL}`);
  assert.equal(maxAgentsLines(series).at(-1), `reproduce: ${series.command}`);
  assert.throws(() => readMaxAgentsSeries(db, { since: UNTIL, until: SINCE }), TypeError);
});
