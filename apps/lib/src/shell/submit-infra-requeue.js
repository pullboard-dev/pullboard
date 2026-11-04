/**
 * An infrastructure failure requeues the same queued candidate; only a test or check failure goes red [C7].
 *
 * Why: on 2 Nov about a third of queued gates bounced red to their builders because a runner dropped, a cleanup
 * timed out, a runner wait ran out or the board was briefly locked. None of those says anything about the builder's
 * work, so the queued worker runs the same candidate again, up to 3 times, preferring another runner; after that the
 * item shows an infrastructure stop for the coordinator, never a red for the builder.
 */
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { effectiveRunners } from '../../../../packages/runners/index.js';
import { probeRunnerTransport } from '../../../../packages/runners/index.js';
import { withAvoidedRunners } from '../../../../packages/gate/index.js';
import { Refused } from '../../../../packages/kernel/index.js';

/** Refusal codes that name the machinery, never the candidate: a rerun of the same source can go green. */
export const INFRASTRUCTURE_CODES = Object.freeze(new Set([
  'RUNNER_UNAVAILABLE', 'RUNNER_JOB_LOST', 'RUNNER_CLEANUP_TIMEOUT', 'RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED',
  'RUNNER_BUSY', 'RUNNER_BROWSER_SLOT_REQUIRED', 'TRANSPORT_LOST', 'CLEANUP_TIMEOUT', 'SLOT_DB_LOCKED', 'BOARD_BUSY',
  'MERGE_CHECK_FAILED',
]));
const LOCKED = /\b(?:database is locked|SQLITE_BUSY)\b/iu;
const PAUSE_MS = 5_000;
const NO_RUNNER_PAUSE_MS = 30_000;
/** Reruns of the same candidate after its first infrastructure failure. */
export const INFRA_RETRIES = 3;
/** A busy board or locked slot database is contention, not a failed gate: it waits and retries before anything counts [C7]. */
export const BUSY_CODES = Object.freeze(new Set(['BOARD_BUSY', 'DATABASE_LOCKED', 'SLOT_DB_LOCKED']));
const BUSY_FIRST_MS = 5_000;
const BUSY_CAP_MS = 60_000;
/** The patience for one run of busy answers: one claim lease. */
const BUSY_BUDGET_MS = 2 * 60 * 60 * 1000;
/** Health waits before an attempt counts as exhausted: about 10 minutes with the default pause. */
const HEALTH_WAITS = 20;

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
 * Run one queued submit attempt, and after an infrastructure failure run the same candidate again, up to
 * INFRA_RETRIES times. Each rerun avoids only the hosts the previous attempt failed on, so it moves to another runner
 * when one is configured, while a host that failed earlier and has since recovered can take it again. With no healthy
 * executor a rerun waits a bounded time for one. When the retries are spent the attempt ends GATE_INFRA_EXHAUSTED,
 * which the board records as an infrastructure stop for the coordinator, not a red for the builder. A real result,
 * green or red, and any other refusal return or throw on the attempt that produced it.
 *
 * @param {(attempt: number, avoided: Set<string>) => Promise<any>} run one complete attempt of the canonical submit
 * @param {{ say?: (line: string) => void, healthy?: () => Promise<boolean>, wait?: (ms: number) => Promise<void>, pauseMs?: number, noRunnerPauseMs?: number, retries?: number }} [options]
 * @returns {Promise<{ result: any, busyWaits: Array<{ code: string, seconds: number }>, attempts: Array<{ attempt: number, code: string, message: string, hosts: string[] }>, avoided: string[] }>}
 */
export async function submitUntilSettled(run, { say = () => {}, healthy = healthyExecutor, wait = pause, pauseMs = PAUSE_MS, noRunnerPauseMs = NO_RUNNER_PAUSE_MS, retries = INFRA_RETRIES, busyBudgetMs = BUSY_BUDGET_MS, busyFirstMs = BUSY_FIRST_MS } = {}) {
  const attempts = [];
  const busyWaits = [];
  let busyMs = 0;
  let busyStreak = 0;
  let avoided = new Set();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await withAvoidedRunners(avoided, () => run(attempt, avoided));
      return { result, attempts, avoided: [...avoided], busyWaits };
    } catch (error) {
      const code = infrastructureFailure(error) ?? (error?.retryable === true ? String(error.code ?? 'RETRYABLE') : null);
      if (!code) throw error;
      if (BUSY_CODES.has(code) && busyMs < busyBudgetMs) {
        // Contention says nothing about the runner or the candidate: wait with backoff, then run the same candidate again.
        const ms = Math.min(busyFirstMs * 2 ** busyStreak, BUSY_CAP_MS, busyBudgetMs - busyMs);
        busyStreak += 1; busyMs += ms; attempt -= 1;
        busyWaits.push({ code, seconds: Math.round(ms / 100) / 10 });
        say(`queued gate hit ${code}: the board is busy, not a gate failure; waiting ${Math.round(ms / 1000)} s and running the same candidate again (no attempt counted)`);
        await wait(ms);
        continue;
      }
      busyMs = 0; busyStreak = 0;
      const hosts = [...new Set(failedHosts(error))];
      attempts.push({ attempt, code, message: String(error.message ?? '').slice(0, 500), hosts });
      if (attempt > retries) throw exhausted(attempts, error);
      // Only the last attempt's failed hosts are avoided: an earlier host that recovered re-enters the pool.
      avoided = new Set(hosts);
      const away = avoided.size ? `, avoiding ${[...avoided].join(', ')}` : '';
      say(`queued gate attempt ${attempt} hit an infrastructure failure (${code}): ${String(error.message ?? '').split('\n')[0]}; requeueing the same candidate${away}, not a red`);
      let waits = 0;
      while (!(await healthy())) {
        if (++waits > HEALTH_WAITS) throw exhausted(attempts, error);
        say(`no healthy runner or local gate slot yet; the candidate waits in the queue and retries in ${Math.round(noRunnerPauseMs / 1000)} s`);
        await wait(noRunnerPauseMs);
      }
      await wait(Math.min(pauseMs * attempt, 6 * pauseMs));
    }
  }
}

/** The infrastructure stop after the retries are spent: the coordinator's to resolve, never the builder's red. */
function exhausted(attempts, cause) {
  const last = attempts.at(-1);
  return Object.assign(new Refused('GATE_INFRA_EXHAUSTED', `the gate stopped on infrastructure ${attempts.length} times (last ${last.code}${last.hosts.length ? ` on ${last.hosts.join(', ')}` : ''}); nothing is wrong with the candidate`,
    'nothing to do as the builder: the coordinator restores the named runner and requeues this gate'), { attempts, cause });
}
