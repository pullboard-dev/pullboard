/** The item timeline reader on a real board: the stages come back in order [C7,#12143]. */
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
