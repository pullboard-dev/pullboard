/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  parentDeathDrainFixture,
  parentDeathTools,
  test,
} from './runners-scenarios.fixture.js';

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains a detached worker descendant before releasing its lease)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools)); // budget: fixture ceiling covers declared30-second remote cleanup plus startup, transport and final cleanup.

test('parent death retries a failed remote holder deletion after the real database writer releases [C7]',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { holdRelease: true })); // budget: same fixture deadline includes the real10-second SQLite busy attempt and release retry.
