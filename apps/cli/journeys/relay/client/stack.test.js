/** Three linked replicas recover a lost stacked submit and refuse a receipt-missing descriptor and agree on the final order [H3,H16,V1,V17]. */
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import {
  after,
  test,
} from 'node:test';
import { publishAcceptedInventories } from '../../../tests/fixtures/relay/client/inventories.js';
import { threeReplicaPhaseCapture } from '../../../tests/fixtures/relay/client/timing.js';
import {
  recoverStackedSubmits,
  threeReplicaFixture,
} from '../../../tests/fixtures/relay/client-harness.js';

after(cleanupFixtureChildren);

test('clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas recover a lost stacked submit and refuse a receipt-missing descriptor', { timeout: 200_000 }, async (t) => {
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    const restoreInventories = await publishAcceptedInventories(fixture);
    await recoverStackedSubmits(fixture, timing, restoreInventories);
    timing.finish(['cloning three replicas', 'stacked-submit recovery']);
  });
});
