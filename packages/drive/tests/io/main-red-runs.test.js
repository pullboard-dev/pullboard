/** The main-red lookup writes its main-test job row to the runs handle it is given, and to the board when given none [P7,C7,#9080]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { classifyGateRed } from '../../index.js';
import { mainRedLookup } from '../../index.js';

const tree = 'c'.repeat(40);
const file = 'packages/drive/tests/io/a.test.js';
const other = 'packages/drive/tests/io/b.test.js';
const command = 'node --test';

/** The ids of the job rows a database holds. */
const jobs = db => db.prepare('SELECT job_id FROM job').all().map(row => row.job_id);

test('clause 1: with a runs handle given (runs_store on), mainRedLookup and classifyGateRed write their main-test job rows only to the runs file [P7,C7,#9080]', t => {
  const board = fixtureBoard(t);
  // A second database with the same job tables stands in for the runs file, held the way boardRunsHolder holds it.
  const runs = { db: fixtureBoard(t).db };
  const lookup = mainRedLookup(board.db, [], { tree, file, command, now: 1000, runs });
  const classified = classifyGateRed(board.db, [], { tree, file: other, command, reds: ['x'], now: 2000, runs });
  assert.ok(lookup.job && classified.job);
  assert.deepEqual(jobs(runs.db).sort(), [lookup.job, classified.job].sort());
  assert.deepEqual(jobs(board.db), [], 'the board holds no main-test job row');
});

test('clause 2: with no runs handle (runs_store off), they write the same board job rows as on main [P7,C7,#9080]', t => {
  const board = fixtureBoard(t);
  const lookup = mainRedLookup(board.db, [], { tree, file, command, now: 1000, runs: null });
  const classified = classifyGateRed(board.db, [], { tree, file: other, command, reds: ['x'], now: 2000 });
  assert.deepEqual(jobs(board.db).sort(), [lookup.job, classified.job].sort());
});
