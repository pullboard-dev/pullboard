/** Three linked replicas order competing claims three and four [H3,H16,V1,V17]. */
import { cleanupFixtureChildren } from '../../../../tests/fixtures/child.js';
import {
  after,
  test,
} from 'node:test';
import { threeReplicaPhaseCapture } from '../../../../tests/fixtures/relay/client/timing.js';
import {
  competingReplicaClaims,
  threeReplicaFixture,
} from '../../../../tests/fixtures/relay/client-harness.js';

after(cleanupFixtureChildren);

test('cli.journeys-relay-client-claims-second-pair.three-cloned-linked-replicas-order-competing: clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas order competing claims three and four', { timeout: 170_000 }, async (t) => { // budget: two paired claim rounds, each about a dozen CLI spawns.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    await competingReplicaClaims(fixture, timing, { ids: [3, 4], tail: false });
    timing.finish(['cloning three replicas', 'competing claims']);
  });
});

