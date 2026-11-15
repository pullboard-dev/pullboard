/**
 * queueRun writes intent, then the board run, then the offer; a crash after each step leaves what the reconciler settles [B2,P7].
 * The crash stops queueRun right after a step commits, drops both connections and reopens both files from disk: each step
 * is its own committed transaction, so the files hold exactly what a killed process leaves (the repo lint keeps node
 * child processes out of cell tests).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../fixtures/cell.js';
import { cellSandbox } from '../../fixtures/cell.js';
import { closeCellBoard } from '../../fixtures/cell.js';
import { openCellBoard } from '../../fixtures/cell.js';
import { INTENT_GRACE_MS } from '../../../index.js';
import { RUN_QUEUED_EVENT } from '../../../index.js';
import { boardRun } from '../../../index.js';
import { openRunsStore } from '../../../index.js';
import { queueRun } from '../../../index.js';
import { reconcileQueued } from '../../../index.js';
import { runsFilePath } from '../../../index.js';
import { runsPort } from '../../../index.js';
import { claimableJobs } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';

const JOB = 'gate:5:abc:t1';
const clock = { now: () => new Date() };

/** The board's id, which stamps its runs file. */
const boardIdOf = board => board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get().meta_value;

/** How many run_queued events the board logged for the job. */
const queuedEvents = (board, job) => board.db.prepare('SELECT event_detail FROM event WHERE event_kind = ?').all(RUN_QUEUED_EVENT)
  .filter(row => JSON.parse(row.event_detail).job === job).length;

/** Thrown from onStep to stop queueRun right after a step commits, as a crash would. */
class Crash extends Error {}

/** Queue the run on a board file, crash right after `stopAt` commits, then reopen both files from disk. */
function crashedAt(t, stopAt) {
  const file = join(cellSandbox(t).dir, 'board.sqlite');
  const first = openCellBoard(file, clock);
  const boardId = boardIdOf(first);
  const before = { db: openRunsStore(runsFilePath(file), { boardId }) };
  assert.throws(() => queueRun(first, runsPort(before), { by: 'coordinator', id: JOB, kind: 'gate', candidate: 'abc' },
    { onStep: step => { if (step === stopAt) throw new Crash(stopAt); } }), Crash);
  before.db.close();
  closeCellBoard(first);
  const board = openCellBoard(file, clock);
  const runs = { db: openRunsStore(runsFilePath(file), { boardId }) };
  t.after(() => { runs.db.close(); closeCellBoard(board); });
  return { board, runs, port: runsPort(runs) };
}

test('queueRun writes the job pending, then the run row and its event, then the offer; a pending job is never claimable [B2,P7]', t => {
  const board = cellBoard(t, ':memory:', clock);
  const runs = { db: openRunsStore(':memory:', { boardId: boardIdOf(board) }) };
  t.after(() => runs.db.close());
  const seen = [];
  queueRun(board, runsPort(runs), { by: 'coordinator', id: JOB, kind: 'gate', candidate: 'abc' }, { onStep: step => {
    seen.push({ step, job: jobView(runs.db, JOB)?.step ?? null, run: boardRun(board.db, JOB)?.run_state ?? null,
      claimable: claimableJobs(runs.db, { runner: 'r1', now: Date.now(), limit: 10 }).length });
  } });
  assert.deepEqual(seen, [
    { step: 'intend', job: 'pending', run: null, claimable: 0 },
    { step: 'move', job: 'pending', run: 'queued', claimable: 0 },
    { step: 'confirm', job: 'offered', run: 'queued', claimable: 1 },
  ]);
  assert.equal(queuedEvents(board, JOB), 1, 'the move logs one run_queued event');
  assert.equal(boardRun(board.db, JOB).run_kind, 'gate');
});

test('a crash after intend leaves a pending job and no run: the reconciler waits, then abandons it past the grace [B2,P7]', t => {
  const { board, runs, port } = crashedAt(t, 'intend');
  assert.equal(boardRun(board.db, JOB), null);
  assert.equal(jobView(runs.db, JOB).step, 'pending');
  assert.equal(reconcileQueued(board, runs, port, JOB), 'wait');
  assert.equal(reconcileQueued(board, runs, port, JOB, { now: Date.now() + INTENT_GRACE_MS }), 'abandoned');
  assert.equal(jobView(runs.db, JOB).step, 'cancelled', 'nothing ran and nothing will');
  assert.equal(claimableJobs(runs.db, { runner: 'r1', now: Date.now(), limit: 10 }).length, 0);
});

test('a crash after the move leaves a queued run with a pending job: the reconciler confirms the offer [B2,P7]', t => {
  const { board, runs, port } = crashedAt(t, 'move');
  assert.equal(boardRun(board.db, JOB).run_state, 'queued');
  assert.equal(jobView(runs.db, JOB).step, 'pending');
  assert.equal(reconcileQueued(board, runs, port, JOB), 'confirmed');
  assert.equal(jobView(runs.db, JOB).step, 'offered');
  assert.equal(reconcileQueued(board, runs, port, JOB), 'settled', 'a second tick changes nothing');
});

test('a crash after confirm leaves a queued run and an offered job: the reconciler has nothing to do [B2,P7]', t => {
  const { board, runs, port } = crashedAt(t, 'confirm');
  assert.equal(boardRun(board.db, JOB).run_state, 'queued');
  assert.equal(jobView(runs.db, JOB).step, 'offered');
  assert.equal(reconcileQueued(board, runs, port, JOB), 'settled');
  assert.equal(queuedEvents(board, JOB), 1);
});

test('retrying queueRun with the same id writes no second job, run row or event [B2,P7]', t => {
  const board = cellBoard(t, ':memory:', clock);
  const runs = { db: openRunsStore(':memory:', { boardId: boardIdOf(board) }) };
  t.after(() => runs.db.close());
  const port = runsPort(runs);
  const job = { by: 'coordinator', id: JOB, kind: 'gate', candidate: 'abc' };
  assert.equal(queueRun(board, port, job).offered, true);
  assert.equal(queueRun(board, port, job).offered, false, 'the retry finds the job already offered');
  assert.equal(runs.db.prepare('SELECT COUNT(*) AS n FROM job WHERE job_id = ?').get(JOB).n, 1);
  assert.equal(runs.db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered'").get(JOB).n, 1);
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run WHERE run_job = ?').get(JOB).n, 1);
  assert.equal(queuedEvents(board, JOB), 1);
});
