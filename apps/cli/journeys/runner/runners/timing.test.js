/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  cli,
  e2e,
  gateResult,
  git,
  runThroughGate,
  runnerStageFixture,
  runnerTimingReceipt,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('machines report busy share and a new run goes to the idle one [C7,O5]', { timeout: 30_000 }, t => runnerStageFixture(t, e2e));

test('registered timing receipt names the physical worker and actual load [C7,Q1]', { timeout: 90_000 },
  t => runnerTimingReceipt(t, { cli, git, runThroughGate, gateResult }));
