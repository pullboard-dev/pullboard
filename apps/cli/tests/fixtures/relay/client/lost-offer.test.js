/** lostGateOffer drops the reply of a submit's gate offer on three linked replicas, leaving a runs_store job row and no hand-off record [C7,P7,#9740]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { cleanupFixtureChildren } from '../../child.js';
import { DatabaseSync } from 'node:sqlite';
import { runsFilePath } from '../../../../../../packages/store/index.js';
import { threeReplicaFixture } from '../client-harness.js';
import { lostGateOffer } from './lost-offer.js';
import { localEvents } from './replica.js';
import { threeReplicaPhaseCapture } from './timing.js';

after(cleanupFixtureChildren);

test('clause 1 and clause 2: [C7,P7,#9740] after lostGateOffer the replica has a runs_store job row for the item and no hand-off record', { timeout: 170_000 }, async (t) => { // budget: one three-replica setup and one submit.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    const { item, job } = await lostGateOffer(fixture, timing);
    assert.ok(Number.isSafeInteger(item) && item > 0, 'it returns the item id');
    const runs = new DatabaseSync(runsFilePath(fixture.replicaFiles[0]), { readOnly: true });
    try {
      const rows = runs.prepare("SELECT job_id FROM job WHERE job_item = ? AND job_kind = 'gate'").all(item);
      assert.deepEqual(rows.map(row => row.job_id), [job], 'the runs store holds the one gate job row the lost offer names');
    } finally { runs.close(); }
    const handedOff = localEvents(fixture.replicaFiles[0]).filter(event => event.item_id === item && event.event_kind === 'fact' && /Gate job .* offered/u.test(event.event_payload ?? ''));
    assert.deepEqual(handedOff, [], 'no hand-off note was recorded');
    timing.finish(['cloning three replicas', 'lost gate offer']);
  });
});
