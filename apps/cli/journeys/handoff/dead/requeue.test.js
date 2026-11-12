/** A gate whose worker died is requeued from its captured candidate with no builder resubmit, three times at most [C7,V4]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { driverRecord } from '../../../tests/fixtures/gate/driver.js';
import { spendDriverRelaunches } from '../../../tests/fixtures/gate/driver.js';
import { RUNNING_RELAUNCH_LIMIT } from '../../../src/io/submit/handoff.js';
import {
  document,
  fixture,
  state,
} from '../../../tests/fixtures/submit/handoff.js';
import { INFRASTRUCTURE_RETRY_LIMIT } from '../../../../../packages/store/index.js';

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

/** Kill only this fixture's recorded detached worker group and observe its actual exit. */
async function killWorker(box, job) {
  const owner = driverRecord(box.boardFile, job.id);
  process.kill(-owner.pid, 'SIGKILL');
  await box.helpers.waitFor(() => gone(owner.pid), 'the worker is gone', 120000); // budget: kill ceiling, no timing assertion.
  // Relaunching a dead running gate comes first (#3995); a worker that keeps dying has spent that budget before recovery requeues.
  spendDriverRelaunches(box.boardFile, job.id, RUNNING_RELAUNCH_LIMIT);
}

/** Run one health sweep as the coordinator from the main checkout: the real dispatcher path; no command by the item's seat runs. */
async function sweep(box) {
  const run = await box.runLocal(box.repo, 'sentinel', 'run', '--health-only');
  assert.equal(run.code, 0, `${run.err}\n${run.out}`);
}

/** Whether the requeued candidate's job finished and the item moved to submitted. */
function submittedAfterRequeue(box) {
  const seen = state(box, box.id);
  return ['green', 'submitted'].includes(seen.job?.state) && seen.item.item_status === 'submitted';
}

/** Wait until the item's current gate job runs, then return it. */
async function runningJob(box) {
  await box.helpers.waitFor(() => state(box, box.id).job?.state === 'running', 'the gate runs', 120000); // budget: real worker readiness ceiling, no timing assertion.
  return state(box, box.id).job;
}

test('clause 1: a worker killed mid-gate is requeued from its exact candidate and finishes with no builder command [C7,V4]', async t => {
  const box = fixture(t);
  assert.equal(document((await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'))).queued, true);
  await box.helpers.waitFor(() => existsSync(box.started), 'the gate started', 120000); // budget: observed gate start ceiling, no timing assertion.
  const job = await runningJob(box);
  await killWorker(box, job);
  await sweep(box);
  const after = state(box, box.id, job.id);
  assert.equal(after.ended.state, 'infrastructure');
  assert.equal(after.ended.error.code, 'SUBMIT_HANDOFF_DEAD');
  assert.notEqual(after.job.id, job.id, 'a successor job holds the candidate');
  for (const field of ['commit', 'tree', 'main', 'executionCommit', 'executionTree', 'digest']) assert.equal(after.job[field], job[field], `${field} is the captured one`);
  assert.equal(after.item.item_status, 'claimed');
  assert.equal(after.returns, 0, 'no builder red and no return to the board');
  writeFileSync(box.release, 'release\n');
  await box.helpers.waitFor(() => submittedAfterRequeue(box), 'the requeued candidate finishes and the item is submitted', 120000); // budget: real gate finish ceiling, no timing assertion.
  assert.equal(state(box, box.id).job.commit, job.commit, 'the same commit finished; no resubmit');
});

test('clause 2: a candidate whose workers die three times stops and the sentinel shouts once, naming it [C7,V4]', async t => {
  assert.equal(INFRASTRUCTURE_RETRY_LIMIT, 3);
  const box = fixture(t);
  assert.equal(document((await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'))).queued, true);
  let job = await runningJob(box);
  const commit = job.commit;
  const killed = [job.id];
  for (let requeue = 1; requeue <= INFRASTRUCTURE_RETRY_LIMIT; requeue++) {
    await killWorker(box, job);
    await sweep(box);
    const next = state(box, box.id, job.id);
    assert.notEqual(next.job.id, job.id, `requeue ${requeue} derives a successor`);
    assert.equal(next.job.infrastructureRetries, requeue);
    assert.equal(next.job.commit, commit);
    job = await runningJob(box);
    killed.push(job.id);
  }
  await killWorker(box, job);
  await sweep(box);
  await sweep(box);
  // A killed worker never removes its disposable checkout; the fixture's cleanup waits for that, so this test removes what it killed.
  for (const id of killed) rmSync(join(box.repo, '.git', 'pullboard', 'submit-handoffs', id, 'source'), { recursive: true, force: true });
  const after = state(box, box.id, job.id);
  assert.equal(after.job.id, job.id, 'no fourth requeue');
  assert.equal(after.job.state, 'infrastructure');
  assert.equal(after.item.item_status, 'claimed');
  assert.equal(after.returns, 0);
  const notices = after.shouts.filter(text => text.includes(`Queued gate #${box.id} exhausted`) && text.includes(commit.slice(0, 12)));
  assert.equal(notices.length, 1, 'one shout names the item and its commit');
});

test('clause 3 reproduction: a stall that kills the worker and its first two requeues leaves no gate needing a builder resubmit [C7,V4]', async t => {
  const box = fixture(t);
  assert.equal(document((await box.runLocal(box.web, 'submit', String(box.id), '--no-next', '--json'))).queued, true);
  let job = await runningJob(box);
  // The stall: the worker and its first two requeues die; the machine is healthy again for the next requeue.
  for (let death = 1; death <= 3; death++) {
    await killWorker(box, job);
    await sweep(box);
    if (death < 3) job = await runningJob(box);
  }
  writeFileSync(box.release, 'release\n');
  await box.helpers.waitFor(() => submittedAfterRequeue(box), 'the third requeue finishes with no builder command', 120000); // budget: real gate finish ceiling, no timing assertion.
  const seen = state(box, box.id);
  const needingResubmit = seen.item.item_status === 'submitted' ? 0 : 1;
  console.log(`# measure #3714: gates needing a builder resubmit after a 3-death stall: ${needingResubmit} of 1`);
  assert.equal(needingResubmit, 0);
});
