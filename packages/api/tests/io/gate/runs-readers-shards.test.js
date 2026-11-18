/** shardJobs and shardedResult take a runs option: with runs_store on they read one sharded gate from the runs file, with it off as on main [P7,#9151]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { SHARD_JOB_KIND } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { postReceipt } from '../../../index.js';
import { shardedResult } from '../../../index.js';
import { shardJobs } from '../../../index.js';

const PARENT = 'gate:9151:parent';
const GREEN = { version: 1, status: 0, gate: { green: true, phases: [{ role: 'proof', status: 0 }] } };

/** One gate job split into two shard jobs, each claimed and given a green receipt, in a database. */
function shardedGate(db) {
  for (const [at, runner] of [[1, 'r-a'], [2, 'r-b']]) {
    const id = `${PARENT}:shard:${at}`;
    offerJob(db, { id, kind: SHARD_JOB_KIND, needs: [], now: at, request: { gate: PARENT, files: [`f${at}.test.js`] } });
    const lease = claimJob(db, { runner, capabilities: [], now: at + 10 });
    postReceipt(db, { job: id, runner, token: lease.token, receipt: GREEN, now: at + 20 });
  }
}

test('api.gate-runs-readers-shards.runs-store-shardjobs-shardedresult-read: clause 1: with runs_store on, shardJobs and shardedResult read one gate split into shard jobs from the runs file as from the job rows off [P7,#9151]', t => {
  const off = cellBoard(t, ':memory:');
  shardedGate(off.db);
  const board = cellBoard(t, ':memory:');
  // A second database with the job tables stands in for the runs file, held the way boardRunsHolder holds it.
  const runs = { db: cellBoard(t, ':memory:').db };
  shardedGate(runs.db);
  const gateReceipt = { version: 1, status: 0, gate: { green: true, phases: [], proofPlan: { files: ['f1.test.js', 'f2.test.js'] } } };
  assert.deepEqual(shardJobs(off.db, PARENT).map(row => row.job_id), [`${PARENT}:shard:1`, `${PARENT}:shard:2`]);
  assert.deepEqual(shardJobs(board.db, PARENT, { runs }), shardJobs(off.db, PARENT));
  const expected = shardedResult(off.db, PARENT, gateReceipt);
  assert.equal(expected.gate.green, true);
  assert.deepEqual(shardedResult(board.db, PARENT, gateReceipt, { runs }), expected);
  assert.deepEqual(shardJobs(board.db, PARENT), [], 'the board itself holds no shard row');
  assert.equal(shardedResult(board.db, PARENT, gateReceipt), null);
});

test('api.gate-runs-readers-shards.runs-store-off-default-shardjobs: clause 3: with runs_store off (the default) shardJobs and shardedResult read the board exactly as on main [P7,#9151]', t => {
  const board = cellBoard(t, ':memory:');
  shardedGate(board.db);
  const gateReceipt = { version: 1, status: 0, gate: { green: true, phases: [] } };
  assert.equal(shardJobs(board.db, PARENT).length, 2);
  assert.deepEqual(shardJobs(board.db, PARENT, { runs: null }), shardJobs(board.db, PARENT));
  assert.deepEqual(shardedResult(board.db, PARENT, gateReceipt, { runs: null }), shardedResult(board.db, PARENT, gateReceipt));
  assert.equal(shardedResult(board.db, PARENT, gateReceipt).gate.shards.length, 2);
});
