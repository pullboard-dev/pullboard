/** Light runner and landing services for an ordinary gate slot, so a plain test run loads no gate, board or machine [C7,V4]. */
import { localRunnerDescriptor } from '../../../../../packages/runners/light.js';
import { sampleRunnerLoad } from '../../../../../packages/runners/light.js';
import { carriedRunnerTrunk } from '../../../../../packages/runners/light.js';
import { probeRunnerTransport } from '../../../../../packages/runners/light.js';
import { effectiveRunners } from '../../../../../packages/runners/light.js';
import { refreshRunnerMeasurements } from '../../../../../packages/runners/light.js';
import { gateQueueSettings } from '../../../../../packages/config/index.js';
import { Refused } from '../../../../../packages/kernel/light.js';

/**
 * Build the execution services withGateSlot validates, loading only what it calls synchronously.
 * Why: the runner and landing front doors statically reach gate.js, packages/store/src/io/board.js and packages/state/src/io/machine.js,
 * which an ordinary run never uses. Async runner probes load the runner front door on first use;
 * the release queue loads its own shell file, not the landing front door, only when current-release-first policy is on.
 * Full gates keep the canonical runnerExecutionServices and landingExecutionServices.
 *
 * @returns {Promise<{ runners: object, landing: object }>} Services shaped for requireGateExecutionServices.
 */
export async function gateSlotServices() {
  /** Load the canonical runner front door the first time a remote probe or dispatch needs it. */
  const front = () => import('../../../../../packages/runners/index.js');
  const runners = Object.freeze({
    sampleRunnerLoad, localRunnerDescriptor, carriedRunnerTrunk, probeRunnerTransport, effectiveRunners, refreshRunnerMeasurements,
    probeRunnerHealth: async (...args) => (await front()).probeRunnerHealth(...args),
    runOnRunnerAsync: async (...args) => (await front()).runOnRunnerAsync(...args),
    runOnRunner: () => { throw new Refused('GATE_SLOT_SERVICES', 'an ordinary gate slot dispatches remote runs itself; use runnerExecutionServices() from the runners front door for gate execution'); },
  });
  const policyOn = gateQueueSettings().currentReleaseFirst;
  const landing = Object.freeze({
    // Policy off: withGateSlot reads the same setting and never asks; a flip between the two reads keeps queue position.
    // The landing door (and its board reader) loads only when a run names an item to rank; an unplanned run reads no board [C7,V4].
    captureReleaseQueue: !policyOn ? () => undefined : async (root, item) => (item === undefined || item === null || item === ''
      ? undefined : (await import('../../../../../packages/landing/index.js')).captureReleaseQueue(root, item)),
    constrainedLandingHost: () => { throw new Refused('GATE_SLOT_SERVICES', 'an ordinary gate slot never lands; use landingExecutionServices() from the landing front door for a landing'); },
    releaseExecutors: () => { throw new Refused('GATE_SLOT_SERVICES', 'an ordinary gate slot runs no release; use landingExecutionServices() from the landing front door for a release'); },
  });
  return Object.freeze({ runners, landing });
}
