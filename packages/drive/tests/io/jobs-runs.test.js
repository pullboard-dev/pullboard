/** The keyed, once, queue and reclaim jobs write their job rows to the runs handle they are given, and to the board when given none [P7,C7,#9008]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { TEST_RUN_KIND } from '../../index.js';
import { driveOnce } from '../../index.js';
import { endDeadGateJobs } from '../../index.js';
import { endLostTestRuns } from '../../index.js';
import { keyedResult } from '../../index.js';
import { lapsedGateJobs } from '../../index.js';

/** The job ids and the step each is at, in a database. */
const jobs = db => db.prepare('SELECT job_id, job_step FROM job').all().map(row => `${row.job_id}:${row.job_step}`).sort();

/** One board, and the handle its jobs go to: a second database standing in for the runs file when `on`, else the board. */
function pair(t, on) {
  const board = fixtureBoard(t);
  const runs = on ? { db: fixtureBoard(t).db } : null;
  return { board, runs, home: runs?.db ?? board.db };
}

/** Run every job path once against one pair, so both clauses compare the same work. */
async function everyPath({ board, runs, home }) {
  await keyedResult(board.db, { kind: 'cells-inventory', key: 'k1', owner: 'd1', produce: () => ({ ok: true }), runs });
  // A gate job at queued whose item moved on: the drive takes its lease and ends it stale, writing only job rows.
  createJob(home, { id: 'gate:once', kind: 'gate', now: 1000 });
  writeStep(home, 'gate:once', 'queued', {}, { now: 1000 });
  const driven = await driveOnce(board.db, 'gate:once', { owner: 'd1', serving: () => false, now: () => 2000, runs });
  // A lapsed gate job whose item left its commit is ended by the reclaim pass.
  createJob(home, { id: 'gate:lapsed', kind: 'gate', item: 7, now: 1000 });
  writeStep(home, 'gate:lapsed', 'queued', {}, { now: 1000 });
  takeJob(home, 'gate:lapsed', 'old', { now: 1000 });
  const later = 1000 + LEASE_MS + 1;
  const lapsed = lapsedGateJobs(board.db, { now: later, runs });
  const ended = endDeadGateJobs(board.db, lapsed, { owner: 'fallback', now: later, active: () => false, runs });
  // A test run whose worker is gone is marked lost.
  createJob(home, { id: 'run:1', kind: TEST_RUN_KIND, now: 1000 });
  writeStep(home, 'run:1', 'queued', { agent: 'a', files: [] }, { now: 1000 });
  takeJob(home, 'run:1', 'test-run:424242', { now: 1000 });
  const lost = endLostTestRuns(board.db, { now: later, alive: () => false, runs });
  return { code: driven.code, lapsed: lapsed.map(job => job.id), ended: ended.map(job => job.ended), lost: lost.map(run => run.id), view: jobView(home, 'gate:once') };
}

test('drive.jobs-runs.with-a-runs-handle-given: clause 1: with a runs handle given (runs_store on), the keyed, once, queue and reclaim jobs write job rows only to the runs file [P7,C7]', async t => {
  const given = pair(t, true);
  const answer = await everyPath(given);
  assert.deepEqual([answer.code, answer.lapsed, answer.ended, answer.lost], ['GATE_STALE', ['gate:lapsed'], ['stale'], ['run:1']]);
  assert.deepEqual(jobs(given.runs.db), ['gate:lapsed:done', 'gate:once:done', 'run:1:done', jobs(given.runs.db).find(row => row.startsWith('cells-inventory'))].sort());
  assert.deepEqual(jobs(given.board.db), [], 'the board holds no job row');
});

test('drive.jobs-runs.with-no-runs-handle-runs: clause 2: with no runs handle (runs_store off), those jobs write the same board job rows as on main [P7,C7]', async t => {
  const off = pair(t, false);
  const answer = await everyPath(off);
  assert.deepEqual([answer.code, answer.lapsed, answer.ended, answer.lost], ['GATE_STALE', ['gate:lapsed'], ['stale'], ['run:1']]);
  const on = pair(t, true);
  await everyPath(on);
  assert.deepEqual(jobs(off.board.db), jobs(on.runs.db), 'the same rows, in the board instead of the runs file');
});
