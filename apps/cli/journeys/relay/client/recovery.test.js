/** Three linked replicas recover lost replies once and agree on the final order [H3,H16,V1,V17]. */
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import {
  after,
  test,
} from 'node:test';
import { threeReplicaPhaseCapture } from '../../../tests/fixtures/relay/client/timing.js';
import {
  recoverReplicaReplies,
  threeReplicaFixture,
} from '../../../tests/fixtures/relay/client-harness.js';

after(cleanupFixtureChildren);

test('clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas recover lost replies once', { timeout: 200_000 }, async (t) => {
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    await recoverReplicaReplies(fixture, timing);
    timing.finish(['cloning three replicas', 'lost-reply recovery']);
  });
});
