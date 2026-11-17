/** cancelGateJob ends an item's live gate job as cancelled through the runs port [C7,#3860]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellSandbox } from '../../../../../store/tests/fixtures/cell.js';
import { cancelGateJob } from '../../../../../store/index.js';
import { openRunsStore } from '../../../../../store/index.js';
import { runsFilePath } from '../../../../../store/index.js';
import { runsPort } from '../../../../../store/index.js';
import { jobView } from '../../../../../jobs/index.js';
import { renewLease } from '../../../../../jobs/index.js';
import { takeJob } from '../../../../../jobs/index.js';
import { finishJob } from '../../../../../jobs/index.js';

/** A real board file and a real runs file beside it, both in a sandbox the test removes. */
function fixture(t) {
  const file = join(cellSandbox(t).dir, 'board.sqlite');
  const board = cellBoard(t, file);
  const db = openRunsStore(runsFilePath(file), { boardId: 'board-a' });
  t.after(() => db.close());
  return { board, runs: { db }, port: runsPort({ db }) };
}

/** Offer a gate job for an item and let a runner take its lease. */
function offerTaken(port, runs, id, item, runner = 'runner-1') {
  port.intend({ id, kind: 'gate', item, now: 1000 });
  port.confirm(id, { now: 1001 });
  assert.equal(takeJob(runs.db, id, runner, { now: 1002 }).taken, true);
}

test('board.cancel-gate-job.cancelgatejob-board-item-runs-writes-the: clause 1: cancelGateJob(board, item, { runs }) writes the cancelled step on the item\'s live gate job, so jobView reads step cancelled [C7,#3860]', t => {
  const { board, runs, port } = fixture(t);
  offerTaken(port, runs, 'gate:7:abc:t', 7);
  offerTaken(port, runs, 'gate:8:abc:t', 8);
  const result = cancelGateJob(board, 7, { runs, now: 2000 });
  assert.deepEqual(result, { written: true, jobs: ['gate:7:abc:t'] });
  assert.equal(jobView(runs.db, 'gate:7:abc:t').step, 'cancelled');
  assert.equal(jobView(runs.db, 'gate:8:abc:t').step, 'offered', 'another item\'s job is untouched');
});

test('board.cancel-gate-job.runner-renew-after-the-cancel-refused: clause 2: a runner renew after the cancel is refused, and a finished job stays finished [C7,#3860]', t => {
  const { board, runs, port } = fixture(t);
  offerTaken(port, runs, 'gate:7:abc:t', 7);
  assert.equal(renewLease(runs.db, 'gate:7:abc:t', 'runner-1', { now: 1500, lapsed: true }), true, 'the runner renews before the cancel');
  cancelGateJob(board, 7, { runs, now: 2000 });
  assert.equal(renewLease(runs.db, 'gate:7:abc:t', 'runner-1', { now: 2001, lapsed: true }), false, 'the cancelled job refuses the renew');

  offerTaken(port, runs, 'gate:9:abc:t', 9, 'runner-2');
  assert.equal(finishJob(runs.db, 'gate:9:abc:t', 'runner-2', { now: 1600 }), true);
  assert.deepEqual(cancelGateJob(board, 9, { runs, now: 2000 }), { written: false, jobs: [] });
  assert.equal(jobView(runs.db, 'gate:9:abc:t').step, 'done', 'a finished job stays finished');
});

test('board.cancel-gate-job.item-with-live-gate-job-returns: clause 3: an item with no live gate job returns written false and writes nothing [C7,#3860]', t => {
  const { board, runs, port } = fixture(t);
  assert.deepEqual(cancelGateJob(board, 5, { runs, now: 2000 }), { written: false, jobs: [] });
  port.intend({ id: 'land:5:k', kind: 'land', item: 5, now: 1000 });
  assert.deepEqual(cancelGateJob(board, 5, { runs, now: 2000 }), { written: false, jobs: [] }, 'only a gate job counts');
  assert.equal(jobView(runs.db, 'land:5:k').step, 'pending');
  assert.deepEqual(cancelGateJob(board, 5, { runs, now: 2000 }), { written: false, jobs: [] });
});
