/** A submit whose gate-offer reply was lost recovers the original gate from the runner job row when submit.recoverFromJobRow is on, and not when it is off [C7,P7,#9740]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import { runsFilePath } from '../../../../../packages/store/index.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { cliResult } from '../../../tests/fixtures/relay/client-harness.js';
import { threeReplicaFixture } from '../../../tests/fixtures/relay/client-harness.js';
import { lostGateOffer } from '../../../tests/fixtures/relay/client/lost-offer.js';
import { threeReplicaPhaseCapture } from '../../../tests/fixtures/relay/client/timing.js';

after(cleanupFixtureChildren);

/** The gate job ids the replica's runs store holds for an item. */
function gateJobs(fixture, item) {
  const runs = new DatabaseSync(runsFilePath(fixture.replicaFiles[0]), { readOnly: true });
  try { return runs.prepare("SELECT job_id FROM job WHERE job_item = ? AND job_kind = 'gate' ORDER BY job_id").all(item).map(row => row.job_id); } finally { runs.close(); }
}

/** Lose one gate offer, set submit.recoverFromJobRow, and submit the item again from the same seat. */
async function submitAgain(t, timing, recoverFromJobRow) {
  const fixture = await threeReplicaFixture(t, timing);
  const { item, job } = await lostGateOffer(fixture, timing);
  fixtureMachineSettings(fixture.envs[0].PULLBOARD_MACHINE_HOME, { submit: { recoverFromJobRow } });
  const again = await timing.wait('submit the item again', () => cliResult(fixture.worktrees[0], fixture.envs[0], 'submit', String(item), '--no-next'));
  return { fixture, item, job, again, detail: JSON.stringify(again.document).slice(0, 1200) };
}

test('clause 1: [C7,P7,#9740] with submit.recoverFromJobRow on, the next submit recovers the offered gate from the runner job row and posts no second offer', { timeout: 170_000 }, async (t) => { // budget: one three-replica setup, a lost offer and one recovering submit.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const { fixture, item, job, again, detail } = await submitAgain(t, timing, true);
    assert.equal(again.status, 0, detail);
    assert.equal(again.document.recovered, true, detail);
    assert.equal(again.document.gateJob, job, 'the recovery names the gate job the lost offer made');
    assert.deepEqual(gateJobs(fixture, item), [job], 'no second gate offer was posted');
    timing.finish(['cloning three replicas', 'lost gate offer']);
  });
});

test('clause 2: [C7,P7,#9740] with submit.recoverFromJobRow off, the job-row recovery does not run and the offered gate job is unchanged', { timeout: 170_000 }, async (t) => { // budget: one three-replica setup, a lost offer and one submit.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const { fixture, item, job, again, detail } = await submitAgain(t, timing, false);
    assert.notEqual(again.document?.recovered, true, detail);
    assert.ok(gateJobs(fixture, item).includes(job), 'the lost offer\'s job row is still there');
    timing.finish(['cloning three replicas', 'lost gate offer']);
  });
});
