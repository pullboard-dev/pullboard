/** A local board serves its runner job queue on loopback through API v1, only under gate.runnerDispatch pull [P7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { apiHttpBox } from '../../../../apps/cli/tests/fixtures/api.js';
import { fixtureMachineSettings } from '../../../../apps/cli/tests/fixtures/testkit.js';
import { jobView } from '../../../jobs/index.js';
import { offerJob } from '../../../jobs/index.js';

test('clauses 1-3: over the loopback API a runner claims by capability, a rival gets nothing, and its receipt lands under the job [P7]', { timeout: 60_000 }, // budget: hang ceiling for a private init and API start, not a throughput claim.
async (t) => {
  const box = await apiHttpBox(t);
  assert.match(box.origin, /^http:\/\/127\.0\.0\.1:\d+$/u, 'a local board serves on loopback');
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  offerJob(db, { id: 'gate:http', kind: 'gate', needs: ['node22'] });
  const jobs = body => box.call(box.path + '/jobs', body);

  const off = await jobs({ action: 'claim', runner: 'r-a', capabilities: ['node22'] });
  assert.deepEqual([off.status, off.document.error.code], [400, 'JOBS_NOT_PULL'], 'the controller path never serves the queue');
  assert.equal(jobView(db, 'gate:http').leaseOwner, null);

  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' } });
  assert.equal((await jobs({ action: 'claim', runner: 'r-thin', capabilities: [] })).document.claim, null, 'a runner without node22 takes nothing');
  const won = await jobs({ action: 'claim', runner: 'r-a', capabilities: ['node22', 'browser'] });
  assert.equal(won.status, 200);
  assert.deepEqual([won.document.claim.job, won.document.claim.attempt], ['gate:http', 1]);
  assert.equal((await jobs({ action: 'claim', runner: 'r-b', capabilities: ['node22'] })).document.claim, null, 'a second claimant is refused while the lease lives');
  const { token } = won.document.claim;
  assert.equal((await jobs({ action: 'renew', job: 'gate:http', runner: 'r-a', token })).document.renewed, true);

  const forged = await jobs({ action: 'receipt', job: 'gate:http', runner: 'r-b', token, receipt: { status: 0 } });
  assert.equal(forged.document.error.code, 'JOB_LEASE_MOVED', 'a receipt from a runner without the claim is refused');
  const posted = await jobs({ action: 'receipt', job: 'gate:http', runner: 'r-a', token, receipt: { status: 0, digest: 'f00d' } });
  assert.deepEqual([posted.status, posted.document.recorded], [200, true]);
  const view = jobView(db, 'gate:http');
  assert.equal(view.step, 'done');
  assert.deepEqual(view.steps.find(step => step.name === 'receipt').payload, { runner: 'r-a', attempt: 1, receipt: { status: 0, digest: 'f00d' } });
});
