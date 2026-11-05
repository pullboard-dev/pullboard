/** Exact committed source and bounded, credential-free SSH execution for machine runners [C7]. */
// The front door: each runner step lives in its own module; this file only re-exports and dispatches.
export { placeRunner, runnerStage } from '../core/runner-stage-model.js';
import { validateRunner } from '../../../gate/index.js';
import { runnerSource } from '../../../gate/index.js';
import { RunnerDropped } from '../../../gate/index.js';
import { inRunnerGeneration } from './runner-remote-tooling.js';
import { pinRunnerTooling } from './runner-remote-tooling.js';
import { runOnRunner as runOnRunnerStep } from './runner-dispatch.js';
import { runOnRunnerAsync as runOnRunnerAsyncStep } from './runner-dispatch.js';
import { serveRunnerController as serveRunnerControllerStep } from './runner-dispatch.js';
import { probeRunnerHealth as probeRunnerHealthStep } from './runner-health.js';
import { probeRunnerJob as probeRunnerJobStep } from './runner-health.js';
import { runnerExecutionServices as runnerExecutionServicesStep } from './runner-health.js';
export { validateRunner, runnerSource, RunnerDropped };


// This instance's controller generation, pinned by its first runner operation and compared by every later one.
let generation = null;

/**
 * Pin this instance's runner tooling on its first runner operation, never at import.
 * Why: capturing the tooling lexes the controller closure in compiler-worker processes; ordinary CLI imports must stay light.
 */
function pinned() { return generation ??= pinRunnerTooling(); }

/** Run one synchronous dispatch under this instance's generation, pinning it first if this is the first operation. */
export function runOnRunner(root, command, options) {
  return inRunnerGeneration(pinned(), () => runOnRunnerStep(root, command, options));
}

/** Isolate asynchronous execution in a fresh controller, refusing tooling changed since this instance loaded. */
export async function runOnRunnerAsync(root, command, options) {
  return inRunnerGeneration(pinned(), () => runOnRunnerAsyncStep(root, command, options));
}

/** Serve only a directly launched controller, under the generation this entry loaded. */
export async function serveRunnerController(ports) {
  return inRunnerGeneration(pinned(), () => serveRunnerControllerStep(ports));
}

/** Ask this instance's pinned worker for exact cleanup or an explicit idle and writable proof. */
export async function probeRunnerHealth(runner, previous, options) {
  return inRunnerGeneration(pinned(), () => probeRunnerHealthStep(runner, previous, options));
}

/** Observe an exact job through this instance's pinned worker generation, never request-selected code. */
export async function probeRunnerJob(runner, identity, options) {
  return inRunnerGeneration(pinned(), () => probeRunnerJobStep(runner, identity, options));
}

/** Supply the canonical late-bound runner operations, bound to this instance's generation. */
export function runnerExecutionServices() {
  return runnerExecutionServicesStep({ runOnRunner, runOnRunnerAsync, probeRunnerHealth });
}

