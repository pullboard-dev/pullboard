/** The Dashboard finished-runs count reads the job table by index, not by a scan [C7,#8480]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../packages/store/index.js';
import { FINISHED_JOBS_SQL } from '../../src/io/serve.js';
import { finishedRuns } from '../../src/io/serve.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';

/** A real private board file with the runs_store split off, so finishedRuns takes the job-table path. */
function jobTableBoard(t) {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  return { project, board };
}

test('view.x-io-finished-runs-plan.clause-1-the-finishedruns-job-table-query: clause 1: the finishedRuns job-table query plan names job_step_updated and does not SCAN job [C7]', t => {
  const { project, board } = jobTableBoard(t);
  store.closeBoard(board);
  const db = new DatabaseSync(project.boardFile, { readOnly: true });
  try {
    assert.equal(store.runsStoreOn(db), false);
    const detail = db.prepare(`EXPLAIN QUERY PLAN ${FINISHED_JOBS_SQL}`).all(0).map(row => row.detail).join('\n');
    assert.match(detail, /job_step_updated/);
    assert.doesNotMatch(detail, /SCAN job\b/);
  } finally { db.close(); }
});

test('view.x-io-finished-runs-plan.clause-1-finishedruns-still-counts-nothing-on: clause 1: finishedRuns still counts nothing on a board with no finished jobs [C7]', t => {
  const { project, board } = jobTableBoard(t);
  store.closeBoard(board);
  assert.deepEqual(finishedRuns(project.repo + '/.git', Date.now()), { gate: 0, landing: 0, test: 0 });
});
