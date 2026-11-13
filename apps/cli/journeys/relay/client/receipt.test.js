/** Three linked replicas refuse a receipt-missing recovered descriptor stacked on an unverified submission [H3,H16,V1,V17]. */
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import {
  after,
  test,
} from 'node:test';
import { publishAcceptedInventories } from '../../../tests/fixtures/relay/client/inventories.js';
import { threeReplicaPhaseCapture } from '../../../tests/fixtures/relay/client/timing.js';
import {
  refuseReceiptMissingStack,
  threeReplicaFixture,
} from '../../../tests/fixtures/relay/client-harness.js';

after(cleanupFixtureChildren);

test('clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas refuse a receipt-missing descriptor stacked on an unverified submission', { timeout: 200_000 }, async (t) => {
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    const restoreInventories = await publishAcceptedInventories(fixture);
    await refuseReceiptMissingStack(fixture, timing, restoreInventories);
    timing.finish(['cloning three replicas', 'receipt-missing stack refusal']);
  });
});
