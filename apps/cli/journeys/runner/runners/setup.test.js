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

test('a refused runner checkout names its failed Git step and stderr [C6,C7]', { concurrency: true }, async t => {
  const modes = ['lock', 'missing', 'large', 'filesystem', 'index', 'custom-filesystem'];
  // Each mode owns its homes, stand-in and controller; two overlap at a time, since six at once starve each other.
  for (let first = 0; first < modes.length; first += 2) {
    await Promise.all(modes.slice(first, first + 2).map(mode => t.test(mode, child => sourceSetupFailureFixture(child, { cli, git, runThroughGate, gateResult }, mode))));
  }
});
