/** heldShards, offeredRequest (the kept-step branch) and openJob take a runs option: with runs_store on they read the runs file, with it off as on main [P7,#9151]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { SHARD_JOB_KIND } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { heldShards } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { offeredRequest } from '../../../index.js';
import { openJob } from '../../../index.js';

const COMMIT = 'd'.repeat(40);
// A request past the offered row's size, so the offered row names the big part and the whole request is kept in a step.
const BIG = { run: ['true'], files: 'x'.repeat(70 * 1024) };

/** One held shard job and one open gate job whose request is kept in a step, in a database. */
function jobs(db) {
  offerJob(db, { id: 'shard-1', kind: SHARD_JOB_KIND, needs: [], now: 1, request: { gate: 'gate:9151:p' } });
  claimJob(db, { runner: 'r-9151', capabilities: [], kinds: [SHARD_JOB_KIND], now: 2 });
  offerJob(db, { id: 'gate:9151:big', kind: 'gate', needs: [], item: 9151, candidate: COMMIT, base: COMMIT, now: 3, request: BIG });
}

/** The three readers' answers for one database: `runs` is the option they are given, or none. */
function answers(board, runs) {
  const option = runs === undefined ? [] : [{ runs }];
  return { held: heldShards(board.db, 'r-9151', 5, ...option), request: offeredRequest(board.db, 'gate:9151:big', ...option),
    open: openJob(board.db, { kind: 'gate', item: 9151, candidate: COMMIT }, ...option)?.id ?? null };
}

test('api.jobs-runs-readers.runs-store-heldshards-kept-step: clause 2: with runs_store on, heldShards, the kept-step branch of offeredRequest and openJob read the runs file as the job rows off [P7,#9151]', t => {
  const off = cellBoard(t, ':memory:');
  jobs(off.db);
  const board = cellBoard(t, ':memory:');
  // A second database with the job tables stands in for the runs file, held the way boardRunsHolder holds it.
  const runs = { db: cellBoard(t, ':memory:').db };
  jobs(runs.db);
  const expected = answers(off);
  assert.equal(expected.held, 1);
  assert.equal(expected.request.files.length, BIG.files.length, 'the whole request is read back from its kept step');
  assert.equal(expected.open, 'gate:9151:big');
  assert.deepEqual(answers(board, runs), expected);
  assert.deepEqual(answers(board).held, 0, 'the board itself holds no shard row');
  assert.equal(answers(board).open, null);
});

test('api.jobs-runs-readers.runs-store-off-default-heldshards: clause 3: with runs_store off (the default) heldShards, offeredRequest and openJob read the board exactly as on main [P7,#9151]', t => {
  const board = cellBoard(t, ':memory:');
  jobs(board.db);
  const main = answers(board);
  assert.equal(main.held, 1);
  assert.equal(main.open, 'gate:9151:big');
  assert.deepEqual(answers(board, null), main, 'a null runs option is the default');
});
