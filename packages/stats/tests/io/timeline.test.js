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
