/** Run the generated pulled-job entry as a separate runner process [C7]. */
import { runFixtureChild } from '../../../../../packages/gate/tests/fixtures/child.js';

/** Execute one generated pulled job with its input and runner environment. */
export function runPulledEntry(entry, root, data, env) {
  return runFixtureChild(process.execPath, [entry, root], { input: JSON.stringify(data), encoding: 'utf8', env, timeout: 120_000 });
}

/** The focused runner executable the generated pulled job runs, shared from the gate fixtures. */
export { focusedRunnerPath } from '../../../../../packages/gate/tests/fixtures/focused-runner.js';
