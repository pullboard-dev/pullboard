/** A withdrawn gate's job is cancelled, so its runner's lease renew is refused and its receipt post writes nothing [C7,#3860,#10222]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { jobView } from '../../../jobs/index.js';
import { cancelGateJob } from '../../../store/index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';
import { postReceipt } from '../../index.js';
import { renewJob } from '../../index.js';

/** A board with one gate job for item 7 that runner `mill` holds. */
function heldGate(t) {
  const { root } = privateFixtureFiles('pullboard-withdrawn-gate-');
  const board = cellBoard(t, join(root, 'board.sqlite'));
  offerJob(board.db, { id: 'gate:7:abc:t', kind: 'gate', item: 7, candidate: 'abc', needs: ['node22'], now: 1000 });
  const claim = claimJob(board.db, { runner: 'mill', capabilities: ['node22'], now: 2000, leaseMs: 120_000 });
  assert.equal(claim.job, 'gate:7:abc:t');
  return { board, claim };
}

test('api.withdrawn-gate-job.renew-after-cancel-refused: clause 1: after cancelGateJob on an item whose gate job a runner holds, renewJob for that runner and token reports renewed false [C7,#3860]', t => {
  const { board, claim } = heldGate(t);
  const request = { job: claim.job, runner: 'mill', token: claim.token };
  assert.equal(renewJob(board.db, { ...request, now: 3000, leaseMs: 120_000 }).renewed, true, 'the runner renews before the withdraw');
  assert.deepEqual(cancelGateJob(board, 7, { now: 4000 }), { written: true, jobs: ['gate:7:abc:t'] });
  assert.deepEqual(renewJob(board.db, { ...request, now: 4001, leaseMs: 120_000 }), { renewed: false, leaseUntil: null });
});

test('api.withdrawn-gate-job.receipt-after-cancel-records-nothing: clause 2: in the same file the runner\'s result post for that job is refused and no receipt row or gate run is recorded [C7,#3860]', t => {
  const { board, claim } = heldGate(t);
  cancelGateJob(board, 7, { now: 4000 });
  const posted = postReceipt(board.db, { job: claim.job, runner: 'mill', token: claim.token, receipt: { status: 0, gate: { green: true } }, now: 4001 });
  assert.equal(posted.recorded, false, 'the cancelled job takes no receipt');
  assert.equal(jobView(board.db, claim.job).step, 'cancelled', 'and stays cancelled');
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt'").get(claim.job).n, 0, 'no receipt row');
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM run WHERE run_kind = 'gate' AND run_item = 7 AND run_state != 'cancelled'").get().n, 0, 'no gate run');
});
