/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  createDescendantTracker,
  orphanTools,
  parseProcessCensus,
  runnerOrphanFixture,
  test,
  unprovenProcessFixture,
} from '../../../tests/fixtures/scenarios/runners.js';

test('a runner job leaves no process behind, detached ones included [C7]',
  { timeout: 150_000 }, t => runnerOrphanFixture(t, orphanTools)); // budget: one plain runner round trip, then the declared 30-second remote cleanup timeout and a local rerun.

test('a runner job leaves no process behind, and never signals a process it cannot prove is the job\'s [C7]',
  { timeout: 30_000 }, t => unprovenProcessFixture(t, { createDescendantTracker, parseProcessCensus })); // budget: scripted census, no real processes.
