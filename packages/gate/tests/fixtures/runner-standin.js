/** Runs a probe under the runner stand-in, so a test never launches node itself [C7]. */
import { fileURLToPath } from 'node:url';
import { runFixtureChildAsync } from './child.js';

const STAND_IN = fileURLToPath(new URL('./cockpit/runner-standin.mjs', import.meta.url));

/**
 * Start the stand-in over a probe script; `.child` is the stand-in process and the promise settles with its result.
 * Why: the stand-in's pid is what a probe must read as its runner pid, and tests may not spawn node directly.
 */
export function runUnderStandIn(probe, args = [], env = process.env) {
  return runFixtureChildAsync(process.execPath, [STAND_IN, probe, ...args], { env });
}
