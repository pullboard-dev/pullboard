/** An interactive pullboard test job's rows go only to the runs file while runs_store is on, and to the board job rows when it is off [P7,B2,#9011]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { offerTestRow } from '../../../src/io/test/pull.js';
import { readTestRow } from '../../../src/io/test/pull.js';
import { TEST_JOB_KIND } from '../../../src/io/test/pull.js';

const ROW = { id: 'test:aaaaaaaaaaaa:tag', kind: TEST_JOB_KIND, priority: 'interactive', needs: [], item: null, candidate: 'a'.repeat(40), base: 'b'.repeat(40), request: { run: ['true'], input: {}, commits: [] }, now: 1000 };

/** The job ids a database holds, and its board run rows. */
const jobIds = db => db.prepare('SELECT job_id FROM job').all().map(row => row.job_id);
const runRows = db => db.prepare('SELECT run_job FROM run').all();

test('clause 1: with runs_store on, the interactive test job writes its job rows only to the runs file [P7,B2,#9011]', t => {
  const board = cellBoard(t, ':memory:');
  // A second database with the job tables stands in for the runs file, held the way boardRunsHolder holds it.
  const runs = { db: cellBoard(t, ':memory:').db };
  const job = offerTestRow(offerJob, { board, runs }, ROW);
  assert.equal(job.id, ROW.id);
  assert.deepEqual(jobIds(runs.db), [ROW.id]);
  assert.deepEqual(jobIds(board.db), [], 'the board holds no test job row');
  assert.equal(readTestRow({ board, runs }, ROW.id).step, 'offered', 'the waiting command reads it from the runs file');
  assert.equal(readTestRow({ board }, ROW.id), null, 'and the board has none to read');
});

test('clause 2: with runs_store on, the interactive test job gets no board run row [P7,B2,#9011]', t => {
  const board = cellBoard(t, ':memory:');
  const runs = { db: cellBoard(t, ':memory:').db };
  offerTestRow(offerJob, { board, runs }, ROW);
  assert.deepEqual(runRows(board.db), []);
  assert.deepEqual(runRows(runs.db), [], 'the runs file keeps none either; only moves decide on a run row');
});

test('clause 3: with runs_store off, the interactive test job writes the same board job rows as on main [P7,B2,#9011]', t => {
  const board = cellBoard(t, ':memory:');
  offerTestRow(offerJob, { board }, ROW);
  const main = cellBoard(t, ':memory:');
  offerJob(main.db, ROW);
  assert.deepEqual(jobIds(board.db), [ROW.id]);
  const steps = db => db.prepare('SELECT job_step_name, job_step_payload FROM job_step ORDER BY job_step_id').all();
  assert.deepEqual(steps(board.db), steps(main.db));
  assert.deepEqual(runRows(board.db), []);
  assert.equal(readTestRow({ board }, ROW.id).step, 'offered');
});
