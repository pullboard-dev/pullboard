/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  browserFreeRunnerCheck,
  browserRefusalRetriesRunner,
  browserRefusalTextStaysRed,
  cli,
  git,
  test,
} from './runners-scenarios.fixture.js';

test('a browser-free check on a runner with no browser slots passes [C7]', { timeout: 180_000 }, t => browserFreeRunnerCheck(t, { cli, git })); // budget: two runner round trips and two local runs.
test('an authenticated browser refusal retries on a remote browser lease [C7]', { timeout: 180_000 }, t => browserRefusalRetriesRunner(t, { cli, git })); // budget: two remote runner round trips.

test('a test that prints the browser refusal text on a runner stays red and is not rerun [C7]', { timeout: 120_000 }, t => browserRefusalTextStaysRed(t, { cli, git })); // budget: one runner round trip.
