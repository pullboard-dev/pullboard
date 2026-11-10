/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  cli,
  gateResult,
  git,
  runThroughGate,
  sourceSetupFailureFixture,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('a refused runner checkout names its failed Git step and stderr [C6,C7]', async t => {
  for (const mode of ['lock', 'missing', 'large', 'filesystem', 'index', 'custom-filesystem']) {
    await t.test(mode, child => sourceSetupFailureFixture(child, { cli, git, runThroughGate, gateResult }, mode));
  }
});
