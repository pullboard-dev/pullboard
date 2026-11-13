/** Three linked replicas order competing claims one to ten, then refuse registration and init outside the relay order [H3,H16,V1,V17]. */
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import {
  after,
  test,
} from 'node:test';
import { threeReplicaPhaseCapture } from '../../../tests/fixtures/relay/client/timing.js';
import {
  competingReplicaClaims,
  threeReplicaFixture,
} from '../../../tests/fixtures/relay/client-harness.js';

after(cleanupFixtureChildren);

test('clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas order competing claims one to ten', { timeout: 170_000 }, async (t) => { // budget: ten paired claim rounds (30 CLI spawns) plus the registration, init and API ordering checks.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    await competingReplicaClaims(fixture, timing, { ids: Array.from({ length: 10 }, (_, index) => index + 1) });
    timing.finish(['cloning three replicas', 'competing claims']);
  });
});

