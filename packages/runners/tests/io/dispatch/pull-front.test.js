/** @pullboard-test-input source-cell packages/runners */
/** @pullboard-world-pin: clauses 1 and 2 read the shipped runners sources to prove the async front and health.js no longer reach dispatch.js. */
/** The async runner front always takes the pull path, so #7526 can delete the SSH transport [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ownedTransportCompletion } from '../../../../transport/index.js';
import * as dispatch from '../../../src/io/dispatch.js';
import { runnerExecutionServices } from '../../../src/io/health.js';

const read = file => readFileSync(new URL(`../../../src/io/${file}`, import.meta.url), 'utf8');

test('runners.pull-front.runonrunnerasync-in-pull-delegate-js-has: clause 1: runOnRunnerAsync in pull/delegate.js has no controller-mode branch and never imports dispatch.js [C7]', () => {
  const source = read('pull/delegate.js');
  assert.doesNotMatch(source, /from '\.\.\/dispatch\.js'/u, 'the delegate imports nothing from dispatch.js');
  assert.doesNotMatch(source, /runnerDispatchMode|controllerRunOnRunnerAsync|ports\.mode/u, 'the delegate reads no dispatch mode and keeps no controller fallback');
  assert.match(source, /export async function runOnRunnerAsync\(root, command, options, ports = \{\}\) \{\n  return runPulled\(/u, 'the async front goes straight to the pulled run');
});

test('runners.pull-front.health-js-imports-neither-runonrunnerasync-nor: clause 2: health.js imports neither runOnRunnerAsync nor ownedTransportCompletion from dispatch.js, and its services still compose [C7]', () => {
  const source = read('health.js');
  assert.doesNotMatch(source, /import \{[^}]*(?:runOnRunnerAsync|ownedTransportCompletion)[^}]*\} from '\.\/dispatch\.js'/u, 'health.js takes neither from dispatch.js');
  assert.equal(dispatch.ownedTransportCompletion, ownedTransportCompletion, 'the transport completion lives in the transport package and stays reachable from dispatch.js');
  const front = { runOnRunner: () => 'sync', runOnRunnerAsync: () => 'async', probeRunnerHealth: () => 'health' };
  const services = runnerExecutionServices(front);
  assert.equal(services.runOnRunnerAsync, front.runOnRunnerAsync, 'the composition root supplies the async front');
  assert.equal(services.probeRunnerHealth, front.probeRunnerHealth, 'the composition root supplies the probe');
});
