/** @pullboard-test-input source-cell apps/runner */
/** @pullboard-world-pin: clauses 1 and 2 read the shipped runner controller source to prove it serves only the pull transport. */
/** The runner app no longer serves the SSH controller, so #7526 can delete it from packages/runners [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const controller = readFileSync(new URL('../../src/io/controller.js', import.meta.url), 'utf8');

test('clause 1: controller.js no longer imports or calls serveRunnerController, and the pull worker still starts [C7]', () => {
  assert.doesNotMatch(controller, /\bserveRunnerController\b/u, 'the SSH controller is not served');
  assert.match(controller, /import \{ servePullController \} from/u, 'the pull controller is imported');
  assert.match(controller, /servePullController\(pullMode,/u, 'a pull mode starts the pull controller');
  assert.match(controller, /PULL_MODES\.includes\(process\.argv\[3\]\)/u, 'the pull mode still comes from the argument');
  assert.match(controller, /RUNNER_CONTROLLER_PULL_ONLY/u, 'a start without a pull mode is refused with its next step');
});

test('clause 2: no apps/runner test targets the retired SSH controller entry [C7]', () => {
  const orphans = readFileSync(new URL('./orphans.test.js', import.meta.url), 'utf8');
  assert.doesNotMatch(orphans, /serveRunnerController/u, 'orphans.test.js never exercised the SSH controller entry');
});
