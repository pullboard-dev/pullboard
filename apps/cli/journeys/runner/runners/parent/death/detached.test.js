/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  parentDeathDrainFixture,
  parentDeathTools,
  test,
} from '../../../../../tests/fixtures/scenarios/runners.js';

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains a detached worker descendant before releasing its lease)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools)); // budget: fixture ceiling covers declared30-second remote cleanup plus startup, transport and final cleanup.

test('parent death queues the remote holder release behind a held database writer and a later resource write lands it [C7,#3084]',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { holdRelease: true })); // budget: same fixture deadline covers the queued release and the later drain write.
