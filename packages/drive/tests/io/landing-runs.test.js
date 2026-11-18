/** A landing run's job rows go to the runs handle it is given, and to the board when given none [P7,C7,#9081]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { driveLanding } from '../../index.js';

/** The job ids and the step each is at, in a database. */
const jobs = db => db.prepare('SELECT job_id, job_step FROM job').all().map(row => `${row.job_id}:${row.job_step}`);

test('drive.landing-runs.with-a-runs-handle-given: clause 1: with a runs handle given (runs_store on), driveLanding writes its job rows only to the runs file [P7,C7,#9081]', async t => {
  const board = fixtureBoard(t);
  // A second database with the same job tables stands in for the runs file, held the way boardRunsHolder holds it.
  const runs = { db: fixtureBoard(t).db };
  await driveLanding(board.db, { owner: 'lander', id: 'land:run:on', runs, run: async () => ({ landed: [] }) });
  await assert.rejects(driveLanding(board.db, { owner: 'lander', id: 'land:run:boom', runs, run: async () => { throw new Error('boom'); } }), /boom/u);
  assert.deepEqual(jobs(runs.db).sort(), ['land:run:boom:done', 'land:run:on:done']);
  assert.deepEqual(jobs(board.db), [], 'the board holds no landing job row');
});

test('drive.landing-runs.with-no-runs-handle-runs: clause 2: with no runs handle (runs_store off), driveLanding writes the same board job rows as on main [P7,C7,#9081]', async t => {
  const board = fixtureBoard(t);
  await driveLanding(board.db, { owner: 'lander', id: 'land:run:off', runs: null, run: async () => ({ landed: [] }) });
  await driveLanding(board.db, { owner: 'lander', id: 'land:run:default', run: async () => ({ landed: [] }) });
  assert.deepEqual(jobs(board.db).sort(), ['land:run:default:done', 'land:run:off:done']);
});
