/** A landing run's job rows go to the runs file when runs_store is on, and to the board when off [P7,C7,#9081]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { boardRunsHolder } from '../../../store/index.js';
import { runsFilePath } from '../../../store/index.js';
import { driveLanding } from '../../index.js';

/** A file-backed board with runs_store set as given, and its path. */
function board(t, on) {
  const open = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  const path = open.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  if (on) open.db.prepare("INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES ('runs_store', '1')").run();
  return { open, path };
}

/** The job ids and the step each is at, in a handle. */
const jobs = db => db.prepare('SELECT job_id, job_step FROM job').all().map(row => `${row.job_id}:${row.job_step}`);

test('clause 1: with runs_store on, the jobs of driveLanding write job rows only to the runs file [P7,C7,#9081]', async t => {
  const { open, path } = board(t, true);
  const runs = boardRunsHolder(open, path);
  assert.equal(existsSync(runsFilePath(path)), false, 'the runs file opens only on first use');
  await driveLanding(open.db, { owner: 'lander', id: 'land:run:on', runs, run: async () => ({ landed: [] }) });
  await assert.rejects(driveLanding(open.db, { owner: 'lander', id: 'land:run:boom', runs, run: async () => { throw new Error('boom'); } }), /boom/u);
  assert.deepEqual(jobs(runs.db).sort(), ['land:run:boom:done', 'land:run:on:done']);
  assert.deepEqual(jobs(open.db), [], 'the board holds no landing job row');
});

test('clause 2: with runs_store off, driveLanding writes the same board job rows as on main [P7,C7,#9081]', async t => {
  const { open, path } = board(t, false);
  assert.equal(boardRunsHolder(open, path), null);
  await driveLanding(open.db, { owner: 'lander', id: 'land:run:off', runs: null, run: async () => ({ landed: [] }) });
  await driveLanding(open.db, { owner: 'lander', id: 'land:run:default', run: async () => ({ landed: [] }) });
  assert.deepEqual(jobs(open.db).sort(), ['land:run:default:done', 'land:run:off:done']);
  assert.equal(existsSync(runsFilePath(path)), false, 'no runs file is made');
});
