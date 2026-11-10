/**
 * An infrastructure failure requeues the same queued candidate; only a test or check failure goes red [C7].
 *
 * The loop itself lives in the gate cell; this module adds the runner health probe that only the app may use,
 * because gate sits below runners (see packages/gate/src/io/requeue.js for the rules and their why).
 */
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { effectiveRunners } from '../../../../../packages/runners/index.js';
import { probeRunnerTransport } from '../../../../../packages/runners/index.js';
import { submitUntilSettled as settle } from '../../../../../packages/gate/index.js';

export { INFRASTRUCTURE_CODES, INFRA_RETRIES, LOCK_CODES, LOCK_WAIT_LIMIT, INVENTORY_WAITS, infrastructureFailure } from '../../../../../packages/gate/index.js';

/**
 * Whether anything can run a gate now: a local gate slot, or a configured runner whose SSH and Node answer.
 * Probes run in parallel and each is bounded by the transport's own short timeout.
 */
export async function healthyExecutor({ settings = loadMachineSettings(), probe = probeRunnerTransport } = {}) {
  if (Number(settings.gateSlots) > 0) return true;
  const runners = effectiveRunners(settings);
  const answers = await Promise.all(runners.map(runner => probe(runner).then(reply => reply?.healthy === true, () => false)));
  return answers.some(Boolean);
}

/**
 * Run one queued submit attempt and rerun it after an infrastructure failure, as the gate cell's loop does, with the
 * runner probe above as the default health check; a caller or fixture may pass its own `healthy`.
 *
 * @param {(attempt: number, avoided: Set<string>) => Promise<any>} run one complete attempt of the canonical submit
 * @param {object} [options] the gate loop's options
 */
export function submitUntilSettled(run, options = {}) {
  return settle(run, { ...options, healthy: options.healthy ?? healthyExecutor });
}
