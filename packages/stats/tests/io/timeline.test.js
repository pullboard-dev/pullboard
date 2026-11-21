/** The item and fleet timeline readers on a real board: the stages come back in order and the cutoff keeps only the window's items [C7,#12143,#12145]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../store/tests/fixtures/submit.js';
import { readFleetTimelines } from '../../index.js';
import { readItemTimeline } from '../../index.js';
import { GATE_QUEUE_SQL } from '../../index.js';

test('stats.io-timeline.real-board: clause 2: readItemTimeline on a real board after an add, claim and submit returns those stages in order, then the gate job stages [C7,#12143]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile);
  const seat = cellSeat(board, { lane: 'core', path: '/builder' });
  const id = cellItem(board, { lane: 'core', title: 'Timeline fixture item' }).item_id;
  cellClaim(board, id, seat, { root: repo.root });
  const hash = '3'.repeat(40);
  submitFixture(board, id, { agentId: seat.id, commit: hash, tree: hash });
  const later = Date.now() + 5000;
  createJob(board.db, { id: `gate:${id}`, kind: 'gate', item: id, now: later });
  writeStep(board.db, `gate:${id}`, 'claimed', { runner: 'r1' }, { now: later + 1000 });
  writeStep(board.db, `gate:${id}`, 'green', {}, { now: later + 2000 });
  const { rows, summary } = readItemTimeline(board, id);
  assert.deepEqual(rows.map(row => row.stage), ['filed', 'claimed', 'submitted', 'gate-queued', 'gate-running', 'gate-settled']);
  assert.ok(rows.every(row => row.item === id));
  assert.equal(rows[4].actor, 'r1');
  assert.equal(summary.total_ms, rows.at(-1).at - rows[0].at);
});

test('stats.io-timeline.gate-wait-real-board: clause 2: readItemTimeline reads an offered gate job and gate-queue snapshot from a real cellBoard and returns the wait reason [C7,#12153]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile);
  const seat = cellSeat(board, { lane: 'core', path: '/builder' });
  const id = cellItem(board, { lane: 'core', title: 'Gate wait fixture item' }).item_id;
  cellClaim(board, id, seat, { root: repo.root });
  const hash = '4'.repeat(40);
  submitFixture(board, id, { agentId: seat.id, commit: hash, tree: hash });
  const at = Date.now() + 5000;
  createJob(board.db, { id: `gate:${id}`, kind: 'gate', item: id, now: at });
  writeStep(board.db, `gate:${id}`, 'offered', {}, { now: at });
  board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, NULL, ?)')
    .run(new Date(at + 1000).toISOString(), 'coordinator', 'gate-queue', JSON.stringify({ queued: [`gate:${id}`], leased: 1, runnersSeen: ['r1'], serveStartedAt: 1 }));
  const result = readItemTimeline(board, id, { now: at + 6000 });
  const row = result.rows.find(value => value.reason === 'NO_RUNNER_SLOT');
  assert.ok(row, JSON.stringify(result.rows));
  assert.equal(row.stage, 'gate-queued');
  assert.equal(result.summary.waits.NO_RUNNER_SLOT, 5000);
});

test('stats.io-timeline.gate-queue-index: clause 3: one indexed gate-queue read is shared across fleet timelines on a scratch live-shape board with 60000 shards, 93 offered gates and 20 snapshots [C7,#12153]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile);
  const first = cellItem(board, { lane: 'core', title: 'First indexed queue fixture' }).item_id;
  const second = cellItem(board, { lane: 'core', title: 'Second indexed queue fixture' }).item_id;
  const ids = Array.from({ length: 93 }, (_, index) => `gate:fixture:${index}`);
  const at = Date.now() + 1000;
  ids.forEach((id, index) => {
    createJob(board.db, { id, kind: 'gate', item: index % 2 ? second : first, now: at });
    writeStep(board.db, id, 'offered', {}, { now: at });
  });
  board.db.exec('BEGIN');
  const insertShard = board.db.prepare("INSERT INTO job (job_id, job_kind, job_step, job_created, job_updated) VALUES (?, 'gate-shard', 'done', 1, 1)");
  for (let index = 0; index < 60000; index += 1) insertShard.run(`gate:fixture:${index % 93}:shard:${Math.floor(index / 93)}`);
  board.db.exec('COMMIT');
  for (let index = 0; index < 20; index += 1) {
    board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, NULL, ?)')
      .run(new Date(at + (index + 1) * 1000).toISOString(), 'coordinator', 'gate-queue', JSON.stringify({ queued: ids, leased: 1, runnersSeen: ['r1'], serveStartedAt: 1 }));
  }
  let queueReads = 0;
  const instrumented = { db: { prepare(sql) { if (sql === GATE_QUEUE_SQL) queueReads += 1; return board.db.prepare(sql); } } };
  const read = readFleetTimelines(instrumented, { since: at - 10_000, now: at + 30_000 });
  assert.deepEqual(read.timelines.map(entry => entry.item), [first, second]);
  assert.equal(queueReads, 1, 'all fleet items share the one gate-queue read');
  const bounds = board.db.prepare('SELECT min(event_id) AS low, max(event_id) AS high FROM event').get();
  const plan = board.db.prepare(`EXPLAIN QUERY PLAN ${GATE_QUEUE_SQL}`).all('gate-queue', bounds.low, bounds.high).map(row => row.detail).join(' | ');
  assert.match(plan, /SEARCH event USING INDEX event_kind_id/u, plan);
  assert.doesNotMatch(plan, /SCAN event/u, plan);
});

test('stats.io-timeline.fleet-real-board: clause 2: readFleetTimelines on a real board with two items and an event before the cutoff returns exactly the two items and the stall inside the window [C7,#12145]', t => {
  const start = Date.parse('2026-11-20T00:00:00.000Z');
  let now = start;
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, { now: () => new Date(now) });
  const stall = (at, route, lagMs) => board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, NULL, ?)').run(new Date(at).toISOString(), 'api', 'api_stall', JSON.stringify({ route, lagMs }));
  const old = cellItem(board, { lane: 'core', title: 'Filed before the cutoff' }).item_id;
  stall(now, '/old', 900);
  now = start + 5 * 60 * 60 * 1000;
  const first = cellItem(board, { lane: 'core', title: 'Filed inside the window' }).item_id;
  now += 1000;
  const second = cellItem(board, { lane: 'core', title: 'Also filed inside the window' }).item_id;
  now += 1000;
  stall(now, '/new', 700);
  const read = readFleetTimelines(board, { since: start + 3 * 60 * 60 * 1000 });
  assert.deepEqual(read.timelines.map(entry => entry.item), [first, second]);
  assert.ok(!read.timelines.some(entry => entry.item === old));
  assert.deepEqual(read.fleetRows.map(entry => [entry.route, entry.ms]), [['/new', 700]]);
  assert.deepEqual(readFleetTimelines(board, { since: start + 9 * 60 * 60 * 1000 }).timelines, [], 'a cutoff past the last event finds no item');
});
