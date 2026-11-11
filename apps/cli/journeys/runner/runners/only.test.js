/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  e2e,
  runnerFirstPolicyCase,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('a machine with runners can run no tests itself [C7]', { timeout: 90_000 }, // budget: covers fixture setup plus three real runner transports and cleanup; not an execution-time target.
  () => runnerFirstPolicyCase(e2e));
