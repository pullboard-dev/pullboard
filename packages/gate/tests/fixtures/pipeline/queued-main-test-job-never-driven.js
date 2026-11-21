/**
 * Invariant: a queued main-test job is driven or ended within its lease, never left queued with no end [C7,P7].
 * Repro: before #6063 nothing ran a main-test under pull, so every row stayed queued for good. Now the board's offer
 * pass pins a job whose tree is on trunk to that commit and offers it to a runner (driven), and ends one whose tree
 * is gone as `unoffered` with the reason (ended). A job a runner took holds a lease that lapses two minutes after its
 * last renewal, when reclaimLapsed lists it again, so it cannot sit claimed and silent either.
 * Runs on a real Git repository and a real SQLite board; no runner process is needed to see the board's half.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../child.js';
import { from } from './kit.js';
import { hopCheck } from './kit.js';
import { LEASE_MS } from '../../../../jobs/index.js';
import { createJob } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';
import { reclaimLapsed } from '../../../../jobs/index.js';
import { renewLease } from '../../../../jobs/index.js';
import { takeJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';

const { cellBoard } = await from('packages/board/tests/fixtures/cell-board.js');

// The offer pass is the board API's own; it is not on the api front door, so the harness loads it by path like the other pipeline harnesses.
const { offerMainTests } = await from('packages/api/src/io/recheck.js');
const COMMAND = 'node --test --test-reporter=tap';

/** A one-commit trunk, its commit and its tree id. */
function trunk(t) {
  const { root, commit } = cellRepo(t);
  return { root, commit, tree: runFixtureGit(['rev-parse', 'HEAD^{tree}'], { cwd: root }) };
}

/** Queue a main-test job the way the gate's main-red lookup does. */
function queue(db, id, tree, now) {
  createJob(db, { id, kind: 'main-test', base: tree, now });
  writeStep(db, id, 'queued', { tree, file: 'a.test.js', command: COMMAND }, { now });
}

test('a queued main-test job is offered at its main commit, or ended unoffered with why: none is left queued [C7,P7]', async t => {
  await hopCheck('main-test-offered', async () => {
    const main = trunk(t);
    const board = cellBoard(t, ':memory:', undefined, { gitRoot: main.root });
    const gone = 'f'.repeat(40);
    queue(board.db, 'main-test:on-trunk', main.tree, 1000);
    queue(board.db, 'main-test:off-trunk', gone, 1000);
    assert.deepEqual(offerMainTests(board, { now: 2000 }), ['main-test:on-trunk'], 'only the job whose tree is on trunk is offered to a runner');
    assert.equal(jobView(board.db, 'main-test:on-trunk').step, 'offered');
    assert.equal(jobView(board.db, 'main-test:on-trunk').candidate, main.commit, 'the offer names the commit a runner can check out');
    const ended = jobView(board.db, 'main-test:off-trunk');
    assert.equal(ended.step, 'unoffered', 'a job no runner can run is ended, not left queued');
    assert.match(String(ended.steps.at(-1).payload.reason), /not among trunk/u);
    assert.deepEqual(board.db.prepare("SELECT job_id FROM job WHERE job_kind = 'main-test' AND job_step = 'queued'").all(), [], 'nothing stays queued after an offer pass');
    return { measured: 'the on-trunk job offered, the off-trunk job unoffered, none queued' };
  });
});

test('a main-test job a runner took is renewed while it runs, and listed as lapsed once its lease runs out [C7,P7]', async t => {
  await hopCheck('main-test-lapsed', async () => {
    const board = cellBoard(t, ':memory:');
    queue(board.db, 'main-test:taken', 'a'.repeat(40), 1000);
    assert.equal(takeJob(board.db, 'main-test:taken', 'runner-1', { now: 1000 }).taken, true);
    assert.equal(renewLease(board.db, 'main-test:taken', 'runner-1', { now: 1000 + LEASE_MS - 1 }), true, 'a live runner keeps the claim');
    assert.deepEqual(reclaimLapsed(board.db, { now: 1000 + LEASE_MS }), [], 'a renewed lease is not lapsed');
    const lapsed = reclaimLapsed(board.db, { now: 1000 + 2 * LEASE_MS });
    assert.deepEqual(lapsed.map(job => [job.id, job.kind]), [['main-test:taken', 'main-test']], 'a silent runner leaves the job listed for anyone to retake');
    return { measured: 'renewed under a live runner; listed lapsed after two leases' };
  });
});
