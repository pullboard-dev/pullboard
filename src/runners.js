/** Exact committed source and bounded, credential-free SSH execution for machine runners [C7]. */
// The front door: each runner step lives in its own module; this file only re-exports and dispatches.
export { placeRunner, runnerStage } from './runner-stage-model.js';
import { validateRunner } from './gate-policy-load.js';
import { runnerSource } from './gate-policy-load.js';
import { RunnerDropped } from './gate-policy-load.js';
import { inRunnerGeneration } from './runner-remote-tooling.js';
import { pinRunnerTooling } from './runner-remote-tooling.js';
import { runOnRunner } from './runner-dispatch.js';
import { runOnRunnerAsync as runOnRunnerAsyncStep } from './runner-dispatch.js';
import { serveRunnerController as serveRunnerControllerStep } from './runner-dispatch.js';
import { refuseLegacyControllerEntry } from './runner-dispatch.js';
import { probeRunnerHealth as probeRunnerHealthStep } from './runner-health.js';
import { runnerExecutionServices as runnerExecutionServicesStep } from './runner-health.js';
export { validateRunner, runnerSource, RunnerDropped };
export { runOnRunner };

// This instance's controller generation, pinned at load as the single file pinned it.
const GENERATION = pinRunnerTooling();

/** Isolate asynchronous execution in a fresh controller, refusing tooling changed since this instance loaded. */
export async function runOnRunnerAsync(root, command, options) {
  return inRunnerGeneration(GENERATION, () => runOnRunnerAsyncStep(root, command, options));
}

/** Serve only a directly launched controller, under the generation this entry loaded. */
export async function serveRunnerController(ports) {
  return inRunnerGeneration(GENERATION, () => serveRunnerControllerStep(ports));
}

/** Ask the worker this instance pinned to prove readiness plus the failed job's cleanup. */
export async function probeRunnerHealth(runner, previous) {
  return inRunnerGeneration(GENERATION, () => probeRunnerHealthStep(runner, previous));
}

/** Supply the canonical late-bound runner operations, bound to this instance's generation. */
export function runnerExecutionServices() {
  return runnerExecutionServicesStep({ runOnRunner, runOnRunnerAsync, probeRunnerHealth });
}

refuseLegacyControllerEntry(import.meta.url);
