/** The small gate readers take a runs option: with runs_store on they read one queued gate from the runs file, with it off exactly as on main [P7,#9149]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { claimJob } from '../../../index.js';
import { latestGateJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { offeredGate } from '../../../index.js';
import { offeredStep } from '../../../index.js';
import { postedReceipt } from '../../../index.js';
import { postReceipt } from '../../../index.js';

const COMMIT = 'c'.repeat(40);
const JOB = 'gate:9149:one';
const RECEIPT = { version: 1, status: 0, gate: { source: COMMIT, green: true, phases: [{ role: 'proof', status: 0 }] } };

/** One queued gate for item 9149 offered, claimed and given its receipt in a database. */
function queueGate(db) {
  offerJob(db, { id: JOB, kind: 'gate', needs: [], item: 9149, candidate: COMMIT, base: COMMIT, now: 1,
    request: { run: ['true'], input: { data: { check: 'node --check x.js' } }, submit: { agentId: 'seat-1', digest: 'd1', tree: 't1', files: ['x.js'] } } });
  const lease = claimJob(db, { runner: 'r-9149', capabilities: [], now: 2 });
  postReceipt(db, { job: JOB, runner: 'r-9149', token: lease.token, receipt: RECEIPT, now: 3 });
}

/** The four readers' answers for one database: `from` is where they look, `runs` the option they are given. */
function answers(board, runs) {
  const option = runs === undefined ? {} : { runs };
  return {
    latest: latestGateJob(board.db, 9149, option),
    offered: offeredGate(board.db, JOB, option),
    step: offeredStep(board.db, JOB, option),
    receipt: postedReceipt(board.db, JOB, option),
  };
}

test('api.gate-runs-readers.runs-store-latestgatejob-offeredgate-offeredstep: clause 1: with runs_store on, latestGateJob, offeredGate, offeredStep and postedReceipt read one queued gate from the runs file as from the job rows off [P7,#9149]', t => {
  const off = cellBoard(t, ':memory:');
  queueGate(off.db);
  const board = cellBoard(t, ':memory:');
  // A second database with the job tables stands in for the runs file, held the way boardRunsHolder holds it.
  const runs = { db: cellBoard(t, ':memory:').db };
  queueGate(runs.db);
  const expected = answers(off);
  assert.equal(expected.latest, JOB);
  assert.equal(expected.offered.item, 9149);
  assert.equal(expected.receipt.receipt.status, 0);
  assert.deepEqual(answers(board, runs), expected);
  assert.deepEqual(answers(board), { latest: null, offered: null, step: null, receipt: null }, 'the board itself holds no job row');
});

test('api.gate-runs-readers.runs-store-off-default-each: clause 2: with runs_store off (the default) each of the four reads the board exactly as on main [P7,#9149]', t => {
  const board = cellBoard(t, ':memory:');
  queueGate(board.db);
  const main = answers(board);
  assert.equal(main.latest, JOB);
  assert.deepEqual(answers(board, null), main, 'a null runs option is the default');
  assert.equal(main.offered.main, COMMIT);
  assert.equal(main.offered.check, 'node --check x.js');
  assert.equal(main.step.request.submit.digest, 'd1');
});
