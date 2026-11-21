/** A pulled gate job whose runner is stopped mid-check hands back its lease and a fresh runner finishes it [V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fixture } from '../../fixtures/submit/handoff.js';
import { gateJob } from '../../fixtures/submit/handoff.js';
import { state } from '../../fixtures/submit/handoff.js';
import { checkPids } from '../../fixtures/submit/recovery.js';
import { freshRunner } from '../../fixtures/submit/recovery.js';
import { gone } from '../../fixtures/submit/recovery.js';
import { lines } from '../../fixtures/submit/recovery.js';
import { runnerPid } from '../../fixtures/submit/recovery.js';
import { runningGate } from '../../fixtures/submit/recovery.js';
import { submitted } from '../../fixtures/submit/recovery.js';
import { transitions } from '../../fixtures/submit/recovery.js';
import { until } from '../../fixtures/submit/recovery.js';

test('cli.journeys-submit-handoff-recovery.a-runner-stopped-mid-check-stops: clause 1: a runner stopped mid-check stops its check and hands back the gate job lease, and a fresh runner finishes the same job with one terminal result [V4,H16,E18,C7]', async t => {
  const box = await fixture(t);
  const job = await runningGate(box);
  const pid = runnerPid(box);
  process.kill(pid, 'SIGTERM');
  await until(box, () => gone(pid), 'the stopped runner exits', 20000); // budget: runner stop ceiling, not a timing assertion.
  await until(box, () => checkPids(box).length === 0, 'the stopped runner stops its check child', 20000); // budget: owned child stop ceiling, not a timing assertion.
  const stopped = gateJob(box);
  assert.equal(stopped.id, job.id, 'the stopped job is not replaced');
  assert.equal(stopped.step, 'claimed', 'a stopped runner ends nothing: its job stays resumable');
  assert.equal(stopped.leaseOwner, null, 'the stopped runner freed its lease for the next runner');
  assert.deepEqual(transitions(stopped), [1, 0], 'the job keeps its one claim and records no result');
  assert.equal(state(box, box.id).item.item_status, 'claimed', 'the builder keeps the claim');
  writeFileSync(box.release, 'release\n');
  freshRunner(box);
  await submitted(box);
  const finished = gateJob(box);
  assert.equal(finished.id, job.id, 'the same job finished');
  assert.equal(finished.step, 'done');
  assert.deepEqual(transitions(finished), [2, 1], 'the fresh runner took the same job again and posted one terminal result');
  assert.equal(lines(box.started), 2, 'the stopped check and the resumed check each began once');
  assert.equal(lines(box.finished), 1, 'only the resumed check finished: the stopped one was stopped');
});
