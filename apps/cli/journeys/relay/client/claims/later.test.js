/** Three linked replicas order competing claims eleven to twenty [H3,H16,V1,V17]. */
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

test('clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas order competing claims eleven to twenty', { timeout: 170_000 }, async (t) => { // budget: the second ten paired claim rounds (30 CLI spawns).
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    await competingReplicaClaims(fixture, timing, { ids: Array.from({ length: 10 }, (_, index) => index + 11), tail: false });
    timing.finish(['cloning three replicas', 'competing claims']);
  });
});

