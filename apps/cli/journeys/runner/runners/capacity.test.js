/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  cli,
  gateResult,
  git,
  observe,
  runnerUsesRegisteredCapacity,
  startQueueController,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('a runner uses the capacity it was registered with [C7,O5]', { timeout: 180_000 }, t => runnerUsesRegisteredCapacity(t, { cli, git, observe, startQueueController, gateResult })); // budget: two rounds of four concurrent runner round trips.
