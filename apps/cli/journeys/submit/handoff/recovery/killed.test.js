/** A pulled gate job whose runner is killed mid-check keeps its lease until it lapses, then a fresh runner finishes it [V4,H16,E18,C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { jobQueueCall } from '../../../../../../packages/api/index.js';
import { fixture } from '../../../../tests/fixtures/submit/handoff.js';
import { gateJob } from '../../../../tests/fixtures/submit/handoff.js';
import { withBoardFile } from '../../../../tests/fixtures/submit/handoff.js';
import { checkPids } from '../../../../tests/fixtures/submit/recovery.js';
import { freshRunner } from '../../../../tests/fixtures/submit/recovery.js';
import { gone } from '../../../../tests/fixtures/submit/recovery.js';
import { runnerPid } from '../../../../tests/fixtures/submit/recovery.js';
import { runningGate } from '../../../../tests/fixtures/submit/recovery.js';
import { submitted } from '../../../../tests/fixtures/submit/recovery.js';
import { transitions } from '../../../../tests/fixtures/submit/recovery.js';
import { until } from '../../../../tests/fixtures/submit/recovery.js';

test('clause 1: a runner killed mid-check keeps the gate job lease until it lapses, and then a fresh runner takes the same job to one verdict [C7]', async t => {
  const box = fixture(t);
  const job = await runningGate(box);
  const pid = runnerPid(box), checks = checkPids(box);
  const holder = job.leaseOwner;
  // The machine dies: the runner and its detached check group go at once, with no chance to hand anything back.
  process.kill(pid, 'SIGKILL');
  for (const check of checks) { try { process.kill(-check, 'SIGKILL'); } catch { try { process.kill(check, 'SIGKILL'); } catch { /* already gone */ } } }
  await until(box, () => gone(pid) && checkPids(box).length === 0, 'the killed runner and its check are gone', 20000); // budget: kill ceiling, not a timing assertion.
  const killed = gateJob(box);
  assert.equal(killed.step, 'claimed', 'the killed runner ended nothing');
  assert.equal(killed.leaseOwner, holder, 'a killed runner keeps its lease until it lapses');
  assert.ok(killed.leaseUntil > Date.now(), 'the lease is still live');
  const capabilities = killed.steps.find(step => step.name === 'claimed').payload.capabilities;
  // A second runner asks the board's queue for work while the dead runner's lease is live.
  const answer = withBoardFile(box, db => jobQueueCall(db, { action: 'claim', runner: 'second-runner', capabilities }, { mode: 'pull' }));
  assert.equal(answer.claim, null, 'no second runner takes the job while the lease is live: ' + JSON.stringify(answer));
  // The lease's two minutes pass; the row reads as it would once they had.
  withBoardFile(box, db => db.prepare('UPDATE job SET job_lease_until = ? WHERE job_id = ?').run(Date.now() - 1, job.id));
  writeFileSync(box.release, 'release\n');
  freshRunner(box);
  await submitted(box);
  const finished = gateJob(box);
  assert.equal(finished.id, job.id, 'the same job finished');
  assert.equal(finished.step, 'done');
  assert.deepEqual(transitions(finished), [2, 1], 'the fresh runner took the lapsed job and posted one terminal result');
});
