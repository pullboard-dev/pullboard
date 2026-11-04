/** A landing-side check command runs on a runner when gate.runnersOnly is on, never on the coordinator machine [C7]. */
import { withGateSlot } from '../../../gate/index.js';
import { runProfiledShellAsync } from '../../../gate/index.js';
import { runnerExecutionServices } from '../../../runners/index.js';
import { gateRunnerAdmission } from '../../../config/index.js';
import { landingExecutionServices } from './landing-shards.js';

/**
 * Run one shell command in a clean committed checkout under a runner-only gate slot and return the run.
 * Why the gate slot: it is the same runner path submit's checks take, so the command queues for a free runner and
 * never falls back to a local process; a machine with no runners keeps running these checks locally (callers decide).
 *
 * @param {string} checkout - A clean committed checkout; the runner receives its HEAD.
 * @param {string} command - The shell command to run at the checkout's root.
 * @param {{ kind: string, admission?: object, onWait?: Function }} options - Receipt kind and the captured runner-only admission.
 * @returns {Promise<{ isGreen: boolean, output: string, executionRunner?: string }>}
 */
export async function runCheckOnRunner(checkout, command, { kind, admission = gateRunnerAdmission(), onWait } = {}) {
  return withGateSlot(checkout, lease => runProfiledShellAsync(checkout, command, { gateLease: lease, waitMs: lease.waitMs }), {
    executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() },
    diagnostic: true, kind, agent: process.env.PULLBOARD_AGENT, onWait, ...admission, runnerOnly: true, remote: true,
  });
}

/** The last few lines of a failed run, for a refusal that names what broke. */
export function runTail(run) {
  return String(run?.output ?? '').trim().split('\n').filter(line => !/ExperimentalWarning|trace-warnings/u.test(line)).slice(-3).join(' ');
}
