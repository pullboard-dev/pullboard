/** The trunk push gate keeps running after a shard goes red and its result names every failing file [C7,#8034]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHARD_JOB_KIND } from '../../../../../packages/api/index.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { combinedReceipt } from '../../../../../packages/api/index.js';
import { failingParts } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { postReceipt } from '../../../../../packages/api/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { awaitPushShards } from '../../../src/io/hook/push.js';
import { shardProblem } from '../../../src/io/hook/push.js';

const JOBS = ['push:abc:tag:shard:1', 'push:abc:tag:shard:2'];
const plan = { shards: [{ files: ['a.test.js', 'ok.test.js'] }, { files: ['b.test.js'] }] };

/** A red shard receipt whose proof phase names the one file that failed. */
const red = file => ({ status: 1, gate: { green: false, phases: [{ role: 'proof', status: 1, failedFiles: [file] }] } });

test('clause 1: a shard that posts red does not stop the gate, which waits for the other shard [C7,#8034]', async t => {
  const { db } = cellBoard(t, ':memory:');
  const clock = { at: 1_000_000 };
  for (const id of JOBS) offerJob(db, { id, kind: SHARD_JOB_KIND, priority: 'gate', now: clock.at });
  const held = JOBS.map(() => claimJob(db, { runner: 'r1', now: clock.at }));
  const on = work => work({ db });
  let polls = 0;
  let returned = false;
  const wait = async () => {
    polls += 1;
    assert.equal(returned, false, 'the gate returned before every shard posted');
    if (polls === 1) postReceipt(db, { job: held[0].job, runner: 'r1', token: held[0].token, receipt: red('a.test.js'), now: clock.at });
    else if (polls === 3) postReceipt(db, { job: held[1].job, runner: 'r1', token: held[1].token, receipt: red('b.test.js'), now: clock.at });
    else if (polls > 4) throw new Error('never settled');
  };
  const settled = await awaitPushShards({}, JOBS, { read: on, write: on, now: () => clock.at, wait, pollMs: 0, limitMs: 60_000 });
  returned = true;
  assert.ok(polls >= 3, 'the gate polled on past the first red shard');
  assert.equal(settled.length, 2);
  assert.deepEqual(settled.map(row => row.posted.receipt.status), [1, 1]);
});

test('clause 2: the result of a run with two red shards names every failing file and no passing one [C7,#8034]', () => {
  const settled = [{ job: JOBS[0], posted: { receipt: red('a.test.js') } }, { job: JOBS[1], posted: { receipt: red('b.test.js') } }];
  const combined = combinedReceipt({ status: 0, gate: { green: true, phases: [] } }, settled);
  const problem = shardProblem(combined, settled, plan, JOBS, failingParts);
  assert.match(problem, /red in 2 of 2 shard jobs/u);
  assert.match(problem, /failing files: a\.test\.js, b\.test\.js\./u);
  assert.doesNotMatch(problem, /ok\.test\.js/u);
});
