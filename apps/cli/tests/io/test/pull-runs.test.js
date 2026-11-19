/** An interactive pullboard test job's rows go only to the runs file while runs_store is on, and to the board job rows when it is off [P7,B2,#9011]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { offerTestRow } from '../../../src/io/test/pull.js';
import { readTestRow } from '../../../src/io/test/pull.js';
import { TEST_JOB_KIND } from '../../../src/io/test/pull.js';
import { loadRerunFiles } from '../../../src/io/test/pull.js';
import { loadPerCore } from '../../../src/io/test/pull.js';

const ROW = { id: 'test:aaaaaaaaaaaa:tag', kind: TEST_JOB_KIND, priority: 'interactive', needs: [], item: null, candidate: 'a'.repeat(40), base: 'b'.repeat(40), request: { run: ['true'], input: {}, commits: [] }, now: 1000 };

/** The job ids a database holds, and its board run rows. */
const jobIds = db => db.prepare('SELECT job_id FROM job').all().map(row => row.job_id);
const runRows = db => db.prepare('SELECT run_job FROM run').all();

test('cli.io-test-pull-runs.with-runs-store-on-the-interactive-test: clause 1: with runs_store on, the interactive test job writes its job rows only to the runs file [P7,B2,#9011]', t => {
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

test('cli.io-test-pull-runs.with-runs-store-on-the-interactive-test-2: clause 2: with runs_store on, the interactive test job gets no board run row [P7,B2,#9011]', t => {
  const board = cellBoard(t, ':memory:');
  const runs = { db: cellBoard(t, ':memory:').db };
  offerTestRow(offerJob, { board, runs }, ROW);
  assert.deepEqual(runRows(board.db), []);
  assert.deepEqual(runRows(runs.db), [], 'the runs file keeps none either; only moves decide on a run row');
});

test('cli.io-test-pull-runs.with-runs-store-off-the-interactive-test: clause 3: with runs_store off, the interactive test job writes the same board job rows as on main [P7,B2,#9011]', t => {
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

/** A red pulled run on `cpus` cores at `load`: each failing case is a TAP block carrying its error line. */
function red(cases, { load = 90, cpus = 10, output = '' } = {}) {
  const tap = cases.map(([name, error]) => `not ok 1 - ${name}\n  ---\n  error: '${error}'\n  failureType: 'testCodeFailure'\n  ...`).join('\n');
  return { green: false, output: `${tap}\n${output}`, failures: cases.map(([name]) => ({ file: 'apps/cli/tests/a.test.js', name })), loadAtStart: load, load: { average: [load, 0, 0], cpus } };
}
const PATHS = ['apps/cli/tests/a.test.js', 'apps/cli/tests/b.test.js'];

test('cli.io-test-pull-runs.a-file-red-only-on-timing-at-load-reruns: clause 1: with test.loadRerun on, a file red only on timing-shaped cases while the runner load per core is over the file-budget cap is offered once more [C7,#10597]', () => {
  const run = red([['slow case', 'fixture CLI worker gave no answer in 45000 ms'], ['other', 'test timed out after 5000ms']]);
  assert.deepEqual(loadRerunFiles(run, PATHS, { enabled: true }), ['apps/cli/tests/a.test.js']);
  assert.equal(loadPerCore(run), 9);
  const killed = { green: false, failures: null, output: 'run-tests: TIMEOUT file "/runner/work/apps/cli/tests/b.test.js" after 180000 ms\n', loadAtStart: 90, load: { average: [90, 0, 0], cpus: 10 } };
  assert.deepEqual(loadRerunFiles(killed, PATHS, { enabled: true }), ['apps/cli/tests/b.test.js'], 'a file the runner killed is timing-shaped');
});

test('cli.io-test-pull-runs.a-file-with-a-real-failure-or-low-load-stays-red: clause 2: a file with any non-timing failing case, or red at a load per core under the cap, is reported red with no rerun [C7,#10597]', () => {
  const mixed = red([['slow case', 'fixture CLI worker gave no answer in 45000 ms'], ['wrong', 'Expected values to be strictly equal']]);
  assert.deepEqual(loadRerunFiles(mixed, PATHS, { enabled: true }), []);
  const calm = red([['slow case', 'fixture CLI worker gave no answer in 45000 ms']], { load: 12 });
  assert.deepEqual(loadRerunFiles(calm, PATHS, { enabled: true }), []);
  assert.deepEqual(loadRerunFiles({ ...red([['slow case', 'x']]), load: null, loadAtStart: null }, PATHS, { enabled: true }), [], 'a runner that named no load is never read as loaded');
});

test('cli.io-test-pull-runs.with-test-loadrerun-off-no-file-reruns: clause 3: with test.loadRerun off, the default, no file reruns however timing-shaped its red is [C7,#10597]', () => {
  const run = red([['slow case', 'fixture CLI worker gave no answer in 45000 ms']]);
  assert.deepEqual(loadRerunFiles(run, PATHS, { enabled: false }), []);
  assert.deepEqual(loadRerunFiles(run, PATHS), [], 'unset reads as off');
});
