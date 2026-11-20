/** A landing's job and finish-step rows go only to the runs file while runs_store is on, and to the board when it is off [P7,#9012]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';
import { landBatch } from '../../../../packages/land/index.js';

/** The job ids and the step names each holds, in a database. */
const rows = db => db.prepare('SELECT job_step_job AS job, job_step_name AS step FROM job_step ORDER BY job_step_id').all().map(row => `${row.job}:${row.step}`);
const jobs = db => db.prepare('SELECT job_id FROM job').all().map(row => row.job_id);

/** A landed one-item batch whose tip is a real commit. */
function landedBatch(t) {
  const repo = cellRepo(t);
  repo.put('feature.txt', 'candidate\n');
  const tip = repo.commitAll();
  return { repo, batch: { id: 'batch-9012', tip, base: repo.commit, state: 'landed', items: [{ id: 9012 }] } };
}

test('cli.io-landing-runs.with-runs-store-on-the-landing-finish: clause 2: with runs_store on, the landing finish steps write job step rows only to the runs file [P7,#9012]', async t => {
  const { repo, batch } = landedBatch(t);
  const board = cellBoard(t, ':memory:');
  // A second database with the job tables stands in for the runs file, held the way boardRunsHolder holds it.
  const runs = { db: cellBoard(t, ':memory:').db };
  const landed = await landBatch(board.db, { repo: repo.root, batch, owner: 'lander', runs });
  assert.equal(landed.commit, batch.tip);
  assert.deepEqual(landed.ran, ['select', 'compose', 'prove', 'merge', 'record', 'publish']);
  assert.equal(jobs(runs.db).length, 1);
  assert.equal(rows(runs.db).length >= 6, true, 'every finish step is a row in the runs file');
  assert.deepEqual(jobs(board.db), [], 'the board holds no landing job row');
  assert.deepEqual(rows(board.db), [], 'and no finish step row');
});

test('cli.io-landing-runs.with-runs-store-off-the-landing-finish: clause 3: with runs_store off, the landing finish steps write the same board job rows as on main [P7,#9012]', async t => {
  const { repo, batch } = landedBatch(t);
  const off = cellBoard(t, ':memory:');
  await landBatch(off.db, { repo: repo.root, batch, owner: 'lander' });
  const none = cellBoard(t, ':memory:');
  await landBatch(none.db, { repo: repo.root, batch, owner: 'lander', runs: null });
  assert.equal(jobs(off.db).length, 1);
  assert.deepEqual(rows(none.db), rows(off.db));
  assert.equal(rows(off.db).length >= 6, true);
});
