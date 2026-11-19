/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  cli,
  gateResult,
  git,
  runThroughGate,
  sourceSetupFailureFixture,
  test,
} from '../../../../tests/fixtures/scenarios/runners.js';

test('cli.journeys-runner-setup-cache.a-refused-runner-checkout-names-its: a refused runner checkout names its failed cache step and stderr [C6,C7]', async t => {
  for (const mode of ['index', 'custom-filesystem']) {
    await t.test(mode, child => sourceSetupFailureFixture(child, { cli, git, runThroughGate, gateResult }, mode));
  }
});
