/**
 * An infrastructure failure requeues the same queued candidate; only a test or check failure goes red [C7].
 *
 * Why: on 2 Nov about a third of queued gates bounced red to their builders because a runner dropped, a cleanup
 * timed out, a runner wait ran out or the board was briefly locked. None of those says anything about the builder's
 * work, so the queued worker runs the same candidate again, on whichever runner is healthy, for as long as one is.
 */
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { effectiveRunners } from '../../../../packages/runners/index.js';
import { probeRunnerTransport } from '../../../../packages/runners/index.js';
import { withAvoidedRunners } from '../../../../packages/gate/index.js';

/** Refusal codes that name the machinery, never the candidate: a rerun of the same source can go green. */
export const INFRASTRUCTURE_CODES = Object.freeze(new Set([
  'RUNNER_UNAVAILABLE', 'RUNNER_JOB_LOST', 'RUNNER_CLEANUP_TIMEOUT', 'RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED',
  'RUNNER_BUSY', 'RUNNER_BROWSER_SLOT_REQUIRED', 'TRANSPORT_LOST', 'CLEANUP_TIMEOUT', 'SLOT_DB_LOCKED', 'BOARD_BUSY',
  'MERGE_CHECK_FAILED',
]));
const LOCKED = /\b(?:database is locked|SQLITE_BUSY)\b/iu;
const PAUSE_MS = 5_000;
const NO_RUNNER_PAUSE_MS = 30_000;

/**
 * The infrastructure code behind a failure, or null when it is a real result (a red test, a red check, a rule).
 * A dropped runner throws RunnerDropped with no code; a raw SQLite lock carries only its message.
 */
export function infrastructureFailure(error) {
  if (!error || typeof error !== 'object') return null;
  if (INFRASTRUCTURE_CODES.has(error.code)) return error.code;
  if (error.name === 'RunnerDropped') return 'TRANSPORT_LOST';
  if ((error.code === undefined || error.code === 'ERR_SQLITE_ERROR') && LOCKED.test(String(error.message ?? ''))) return 'DATABASE_LOCKED';
  return null;
}

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

/** Every runner host a failure names: the gate's own mark, a dropped runner, and its recorded attempts. */
function failedHosts(error) {
  const attempts = Array.isArray(error?.infrastructureAttempts) ? error.infrastructureAttempts : [];
  return [error?.runnerHost, error?.name === 'RunnerDropped' ? error.host : null, ...attempts.map(row => row?.runner)]
    .filter(host => typeof host === 'string' && host && host !== 'local');
}

/** Resolve after `ms`; a separate function so a fixture can supply its own clock. */
function pause(ms) {
  return new Promise(done => setTimeout(done, ms));
}

/**
 * Run one queued submit attempt, and run the same candidate again after every infrastructure failure, with no retry
 * limit while any executor is healthy; with none healthy it waits for one. Every runner that failed is avoided by
 * the later attempts, so the candidate moves to another runner; only when no other runner is configured does it go
 * back to the full pool, after the health wait, because the failed host may be the only one left. A real result, green or red, and any
 * other refusal return or throw on the attempt that produced it, so only a test or check failure reaches the builder.
 *
 * @param {(attempt: number) => Promise<any>} run one complete attempt of the canonical submit
 * @param {{ say?: (line: string) => void, healthy?: () => Promise<boolean>, wait?: (ms: number) => Promise<void>, pauseMs?: number, noRunnerPauseMs?: number }} [options]
 * @returns {Promise<{ result: any, attempts: Array<{ attempt: number, code: string, message: string, hosts: string[] }>, avoided: string[] }>}
 */
export async function submitUntilSettled(run, { say = () => {}, healthy = healthyExecutor, wait = pause, pauseMs = PAUSE_MS, noRunnerPauseMs = NO_RUNNER_PAUSE_MS } = {}) {
  const attempts = [];
  const avoided = new Set();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await withAvoidedRunners(avoided, () => run(attempt));
      return { result, attempts, avoided: [...avoided] };
    } catch (error) {
      const code = infrastructureFailure(error);
      if (!code) throw error;
      const hosts = [...new Set(failedHosts(error))];
      for (const host of hosts) avoided.add(host);
      attempts.push({ attempt, code, message: String(error.message ?? '').slice(0, 500), hosts });
      const away = avoided.size ? `, avoiding ${[...avoided].join(', ')}` : '';
      say(`queued gate attempt ${attempt} hit an infrastructure failure (${code}): ${String(error.message ?? '').split('\n')[0]}; requeueing the same candidate${away}, not a red`);
      while (!(await healthy())) {
        say(`no healthy runner or local gate slot yet; the candidate waits in the queue and retries in ${Math.round(noRunnerPauseMs / 1000)} s`);
        await wait(noRunnerPauseMs);
      }
      await wait(Math.min(pauseMs * attempt, 6 * pauseMs));
    }
  }
}
