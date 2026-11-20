/** The flake-diagnose job writes its rows to the runs handle it is given, and to the board when given none [P7,C7,#9009]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { driveFlakeDiagnose } from '../../index.js';
import { flakeDiagnosesFor } from '../../index.js';
import { queueFlakeDiagnoses } from '../../index.js';

const gate = { id: 'gate:9', item: 9, candidate: 'c'.repeat(40) };
const failures = [{ file: 'web/a.test.js', case: 'renders' }];

/** The job ids and the step each is at, in a database. */
const jobs = db => db.prepare('SELECT job_id, job_step FROM job').all().map(row => `${row.job_id}:${row.job_step}`);

/** Queue and drive one diagnosis against a board and the handle its rows go to. */
async function diagnoseOnce(board, runs, home) {
  const [id] = queueFlakeDiagnoses(board.db, gate, 'd'.repeat(40), failures, { now: 1000, runs });
  const driven = await driveFlakeDiagnose(board.db, id, { owner: 'd1', diagnose: () => ({ classification: 'flaky' }), now: () => 2000, runs });
  return { driven, listed: flakeDiagnosesFor(board.db, 9, { runs }), rows: jobs(home) };
}

test('drive.diagnose-runs.with-a-runs-handle-given: clause 1: with a runs handle given (runs_store on), the diagnose job writes its job rows only to the runs file [P7,C7]', async t => {
  const board = fixtureBoard(t);
  const runs = { db: fixtureBoard(t).db };
  const { driven, listed, rows } = await diagnoseOnce(board, runs, runs.db);
  assert.equal(driven.transition, 'attached');
  assert.deepEqual(listed.map(row => row.result), [{ classification: 'flaky' }]);
  assert.equal(rows.length, 1, 'the diagnose job is in the runs file');
  assert.deepEqual(jobs(board.db), [], 'the board holds no job row');
});

test('drive.diagnose-runs.with-no-runs-handle-runs: clause 2: with no runs handle (runs_store off), the diagnose job writes the same board job rows as on main [P7,C7]', async t => {
  const board = fixtureBoard(t);
  const off = await diagnoseOnce(board, null, board.db);
  assert.equal(off.driven.transition, 'attached');
  assert.equal(off.rows.length, 1, 'the board holds the diagnose job');
});
