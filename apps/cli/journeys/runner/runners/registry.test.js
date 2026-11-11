/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  cli,
  e2e,
  gateResult,
  git,
  observe,
  removingBusyRunnerDrains,
  runnerRemoveKeepsSettings,
  startQueueController,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('runner remove deletes one runner and keeps the rest [C7]', (t) => runnerRemoveKeepsSettings(t, e2e));

test('removing a busy runner drains it [C7]', (t) => removingBusyRunnerDrains(t, { cli, git, observe, startQueueController, gateResult }));
