/** A gate drive's job rows go to the runs handle it is given, and to the board when given none [P7,C7,#9082]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { admitGateDrive } from '../../index.js';
import { endGateDriveUnstarted } from '../../index.js';
import { readGateDrive } from '../../index.js';
import { recordGateDriveSpawn } from '../../index.js';

/** The job ids and the step each is at, in a database. */
const jobs = db => db.prepare('SELECT job_id, job_step FROM job').all().map(row => `${row.job_id}:${row.job_step}`);

/** Admit one gate drive, record its spawn, and end another unstarted, through the given runs handle (or none). */
function drive(board, runs) {
  const options = runs === undefined ? {} : { runs };
  admitGateDrive(board.db, 'gate:1:a', { owner: 'driver-1', now: 1000, ...options });
  recordGateDriveSpawn(board.db, 'gate:1:a', { owner: 'driver-1', pid: 4242, started: 'Mon Nov 16 00:00:00 2026', now: 2000, ...options });
  endGateDriveUnstarted(board.db, 'gate:2:b', { owner: 'driver-2', code: 'X', message: 'no start', now: 3000, ...options });
}

test('drive.gate-runs.with-a-runs-handle-given: clause 1: with a runs handle given (runs_store on), the gate drive writes its job rows only to the runs file [P7,C7,#9082]', t => {
  const board = fixtureBoard(t);
  // A second database with the same job tables stands in for the runs file, held the way boardRunsHolder holds it.
  const runs = { db: fixtureBoard(t).db };
  drive(board, runs);
  assert.equal(jobs(runs.db).length, 2);
  assert.ok(jobs(runs.db).some(row => row.endsWith(':spawned')));
  assert.deepEqual(jobs(board.db), [], 'the board holds no gate drive job row');
  assert.notEqual(readGateDrive(board.db, 'gate:1:a', { runs }), null, 'the record reads from the runs file');
  assert.equal(readGateDrive(board.db, 'gate:1:a'), null, 'and not from the board');
});

test('drive.gate-runs.with-no-runs-handle-runs: clause 2: with no runs handle (runs_store off), the gate drive writes the same board job rows as on main [P7,C7,#9082]', t => {
  const board = fixtureBoard(t);
  drive(board, undefined);
  const none = fixtureBoard(t);
  drive(none, null);
  assert.equal(jobs(board.db).length, 2);
  assert.deepEqual(jobs(none.db), jobs(board.db));
  assert.notEqual(readGateDrive(board.db, 'gate:1:a'), null);
});
