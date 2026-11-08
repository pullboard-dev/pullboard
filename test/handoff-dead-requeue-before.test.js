/** Measurement of #3714 on the commit before the change: how many gates a 3-death stall leaves needing a builder resubmit [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { driverRecord } from './gate-driver-fixture.js';
import { document, fixture, state } from './submit-handoff-fixture.js';

/** Whether a process is gone; any other signal error leaves it presumed alive. */
function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

test('clause 3 measurement before: a stall that kills the worker and its first two requeues [C7,V4]', async t => {
  const box = fixture(t);
  assert.equal(document(box.run(box.web, 'submit', String(box.id), '--no-next', '--json')).queued, true);
  await box.helpers.waitFor(() => existsSync(box.started), 'the gate started', 120000); // budget: observed gate start ceiling, no timing assertion.
  let job = state(box, box.id).job;
  for (let death = 1; death <= 3; death++) {
    const owner = driverRecord(box.boardFile, job.id);
    process.kill(-owner.pid, 'SIGKILL');
    await box.helpers.waitFor(() => gone(owner.pid), 'the worker is gone', 120000); // budget: kill ceiling, no timing assertion.
    const run = box.run(box.repo, 'sentinel', 'run', '--health-only');
    assert.equal(run.code, 0, `${run.err}\n${run.out}`);
    if (death < 3) {
      await box.helpers.waitFor(() => state(box, box.id).job?.state === 'running', 'the requeued gate runs', 120000); // budget: real worker readiness ceiling, no timing assertion.
      job = state(box, box.id).job;
    }
  }
  const seen = state(box, box.id);
  const needingResubmit = seen.job.state === 'infrastructure' ? 1 : 0;
  console.log(`# measure #3714 before: gates needing a builder resubmit after a 3-death stall: ${needingResubmit} of 1 (job ${seen.job.state}, requeues ${seen.job.infrastructureRetries ?? 0})`);
  assert.ok(true);
});
