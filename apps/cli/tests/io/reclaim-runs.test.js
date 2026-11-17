/** The reclaim fallback opens the runs file only while runs_store is on, and ends a lapsed gate job where it lives [P7,#9113]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createJob } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { RUNS_STORE_KEY } from '../../../../packages/store/index.js';
import { boardRunsHolder } from '../../../../packages/store/index.js';
import { runsFilePath } from '../../../../packages/store/index.js';
import { withFixtureBoard } from '../fixtures/board.js';
import { createE2eHelpers } from '../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose board holds, in the handle `home` names, one gate job that lapsed long ago for an item that is gone. */
function lapsedBox(flag) {
  const box = e2e.project(undefined, undefined, { withWorktree: false });
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  withFixtureBoard(file, board => {
    if (flag) board.db.prepare('INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
    const home = flag ? boardRunsHolder(board, file).db : board.db;
    createJob(home, { id: 'gate:lapsed', kind: 'gate', item: 7, now: 1000 });
    writeStep(home, 'gate:lapsed', 'queued', {}, { now: 1000 });
    takeJob(home, 'gate:lapsed', 'old', { now: 1000 });
  });
  return { box, file };
}

/** Where the job is now: its step on the board and in the runs file (null when the runs file was never made). */
function stepsOf({ file }) {
  const step = db => db.prepare("SELECT job_step FROM job WHERE job_id = 'gate:lapsed'").get()?.job_step ?? null;
  return withFixtureBoard(file, board => ({ board: step(board.db), runs: existsSync(runsFilePath(file)) ? step(boardRunsHolder(board, file)?.db ?? board.db) : null }));
}

test('cli.io-reclaim-runs.with-runs-store-on-status-reclaims-the: clause 1: with runs_store on, status reclaims the lapsed gate job in the runs file [P7,#9113]', async () => {
  const given = lapsedBox(true);
  const status = await given.box.inProcess(given.box.repo, 'status');
  assert.equal(status.code, 0, `${status.out}${status.err}`);
  const steps = stepsOf(given);
  assert.equal(steps.board, null, 'the board holds no gate job row');
  assert.notEqual(steps.runs, 'queued', 'the runs file job was ended by the fallback');
});

test('cli.io-reclaim-runs.with-runs-store-off-status-reclaims-on: clause 1: with runs_store off, status reclaims on the board and opens no runs file [P7,#9113]', async () => {
  const given = lapsedBox(false);
  const status = await given.box.inProcess(given.box.repo, 'status');
  assert.equal(status.code, 0, `${status.out}${status.err}`);
  assert.notEqual(stepsOf(given).board, 'queued', 'the board job was ended by the fallback');
  assert.equal(existsSync(runsFilePath(given.file)), false, 'no runs file was made');
});
