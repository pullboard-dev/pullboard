/** @pullboard-test-input source-cell apps/cli packages/store packages/board packages/kernel packages/jobs */
/** pullboard doctor runs one reconciler tick when the runs_store flag is on, and says nothing about it when off [B2,P7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { fixtureOpenBoard } from '../../fixtures/board.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { LOST_GRACE_MS } from '../../../../../packages/store/index.js';
import { boardRun } from '../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { recordQueuedRun } from '../../../../../packages/store/index.js';
import { writeBoardMeta } from '../../../../../packages/store/index.js';

/** A fixture project whose board holds a queued run older than the grace, its job missing from the runs file; the flag is `flag`. */
function projectWithLostRun(t, { flag }) {
  const box = apiHttpFixture(t);
  const board = fixtureOpenBoard({ boardFile: join(box.root, '.git', 'pullboard', 'board.sqlite'), web: box.root });
  try {
    if (flag) writeBoardMeta(board.db, 'runs_store', '1');
    recordQueuedRun(board, { by: 'coordinator', id: 'gate:lost', kind: 'gate' });
    board.db.prepare("UPDATE run SET run_created = ? WHERE run_job = 'gate:lost'").run(Date.now() - LOST_GRACE_MS - 60_000);
  } finally { closeBoard(board); }
  return box;
}

/** The state of the lost run after doctor, read from the board file. */
function runState(box) {
  const board = fixtureOpenBoard({ boardFile: join(box.root, '.git', 'pullboard', 'board.sqlite'), web: box.root });
  try { return boardRun(board.db, 'gate:lost').run_state; } finally { closeBoard(board); }
}

test('cli.io-commands-doctor-reconcile.doctor-on-a-board-with-the-runs: clause 1: doctor on a board with the runs_store flag on and one lost job runs one reconciler tick and prints the job it settled [B2,P7]', async t => {
  const box = projectWithLostRun(t, { flag: true });
  const ran = await runCliInProcess(['doctor', '--reconcile'], { cwd: box.root, env: box.env });
  assert.match(ran.stdout, /reconciler: settled gate:lost \(lost\)/u, ran.stdout + ran.stderr);
  assert.equal(runState(box), 'lost', 'the tick moved the board run');
});

test('cli.io-commands-doctor-reconcile.doctor-on-a-board-with-the-flag: clause 2: doctor on a board with the flag off prints no reconciler line [B2,P7]', async t => {
  const box = projectWithLostRun(t, { flag: false });
  const ran = await runCliInProcess(['doctor'], { cwd: box.root, env: box.env });
  assert.doesNotMatch(ran.stdout + ran.stderr, /reconciler/u);
  assert.equal(runState(box), 'queued', 'with the flag off the run is left alone');
});

test('cli.io-commands-doctor-reconcile.default-doctor-takes-no-write: clause 1: a default doctor on a board with the flag on and one lost job prints no reconciler line and leaves the job unsettled [B2,P7]', async t => {
  const box = projectWithLostRun(t, { flag: true });
  const ran = await runCliInProcess(['doctor'], { cwd: box.root, env: box.env });
  assert.doesNotMatch(ran.stdout + ran.stderr, /reconciler/u);
  assert.equal(runState(box), 'queued', 'a default doctor takes no write lock and settles nothing');
});
