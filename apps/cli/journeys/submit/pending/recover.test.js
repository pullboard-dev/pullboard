/** A submit whose gate-offer reply was lost recovers the original gate from the runner job row when submit.recoverFromJobRow is on, and not when it is off [C7,P7,#9740]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Forget the offer note the seat held, as a seat that died between offering the gate job and holding the note would: only the job row is left of the offer. */
function forgetHeldNote(fixture) {
  const link = join(fixture.commonDir(fixture.clones[0], fixture.envs[0]), 'pullboard', 'relay.json');
  const state = JSON.parse(readFileSync(link, 'utf8'));
  assert.ok(state.pending?.move, 'the lost offer left its note held');
  delete state.pending;
  writeFileSync(link, JSON.stringify(state) + '\n', { mode: 0o600 });
}

/** Submit the item again from the seat that lost the offer, under the given submit.recoverFromJobRow. */
async function submitAgain(fixture, timing, item, recoverFromJobRow) {
  fixtureMachineSettings(fixture.envs[0].PULLBOARD_MACHINE_HOME, { submit: { recoverFromJobRow } });
  const again = await timing.wait(`submit the item again with recoverFromJobRow ${recoverFromJobRow ? 'on' : 'off'}`, () => cliResult(fixture.worktrees[0], fixture.envs[0], 'submit', String(item), '--no-next'));
  return { again, detail: JSON.stringify(again.document).slice(0, 1200) };
}

test('cli.journeys-submit-pending-recover.a-lost-gate-offer-reply-is: clause 1 and clause 2: [C7,P7,#9740] a lost gate-offer reply is recovered from the runner job row with submit.recoverFromJobRow on, with no second offer, and not with it off', { timeout: 170_000 }, async (t) => { // budget: one three-replica setup, a lost offer and two submits.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    const { item, job } = await lostGateOffer(fixture, timing);
    forgetHeldNote(fixture);
    const on = await submitAgain(fixture, timing, item, true);
    assert.equal(on.again.status, 0, on.detail);
    assert.equal(on.again.document.recovered, true, on.detail);
    assert.equal(on.again.document.gateJob, job, 'the recovery names the gate job the lost offer made');
    assert.deepEqual(gateJobs(fixture, item), [job], 'recovery posted no second offer');
    // The same item submitted again with the setting off is no recovery: the job-row path is the setting's alone.
    const off = await submitAgain(fixture, timing, item, false);
    assert.notEqual(off.again.document?.recovered, true, off.detail);
    timing.finish(['cloning three replicas', 'lost gate offer']);
  });
});
