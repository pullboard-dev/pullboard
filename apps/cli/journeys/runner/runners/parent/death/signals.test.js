/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  parentDeathDrainFixture,
  parentDeathTools,
  test,
} from '../../../../../tests/fixtures/scenarios/runners.js';

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains its worker while the command keeps writing output)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { chatty: true })); // budget: same fixture ceiling as the ordinary parent-death case.

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains its worker when a group signal answers EPERM)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { epermOnce: true })); // budget: same fixture ceiling as the ordinary parent-death case.

test('a queued run executes on a registered runner and its result comes back [C7] (parent death drains a child that leaves its group after the first census)',
  { timeout: 90_000 }, t => parentDeathDrainFixture(t, parentDeathTools, { lateGroup: true })); // budget: same fixture ceiling as the ordinary parent-death case.
