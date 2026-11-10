/**
 * An infrastructure failure requeues the same queued candidate; only a test or check failure goes red [C7].
 *
 * Why: on 2 Nov about a third of queued gates bounced red to their builders because a runner dropped, a cleanup
 * timed out, a runner wait ran out or the board was briefly locked. None of those says anything about the builder's
 * work, so the queued worker runs the same candidate again, up to 3 times, preferring another runner; after that the
 * item shows an infrastructure stop for the coordinator, never a red for the builder.
 */
import { Refused } from '../../../kernel/index.js';
import { INFRASTRUCTURE_CODES } from '../../../store/index.js';
import { withAvoidedRunners } from './slot.js';

/** Refusal codes that name the machinery, never the candidate: the board's own set, so both sides agree [C7]. */
export { INFRASTRUCTURE_CODES };
const LOCKED = /\b(?:database is locked|SQLITE_BUSY)\b/iu;
const PAUSE_MS = 5_000;
const NO_RUNNER_PAUSE_MS = 30_000;
/** Reruns of the same candidate after its first infrastructure failure. */
export const INFRA_RETRIES = 3;
/** Health waits before an attempt counts as exhausted: about 10 minutes with the default pause. */
const HEALTH_WAITS = 20;
/**
 * Lock stops: the board or a slot database was busy for a moment. They wait with backoff and never spend a retry.
 * Why: on 4 Nov 51 of 80 gates ended GATE_INFRA_EXHAUSTED after four lock stops alone (#3087); a lock always frees.
 */
export const LOCK_CODES = Object.freeze(new Set(['BOARD_BUSY', 'SLOT_DB_LOCKED', 'DATABASE_LOCKED']));
/** Lock waits one candidate may spend before the stop is an infrastructure stop, never a red (#3101). */
export const LOCK_WAIT_LIMIT = 60;
const LOCK_PAUSE_MS = 1_000;
const LOCK_MAX_PAUSE_MS = 30_000;
/** Inventory waits that spend no retry; each main move may need one, and the bound keeps the loop finite. */
export const INVENTORY_WAITS = 8;

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

/** Every runner host a failure names: the gate's own mark, its lease's runner, a dropped runner, and its recorded attempts. */
function failedHosts(error) {
  const attempts = Array.isArray(error?.infrastructureAttempts) ? error.infrastructureAttempts : [];
  return [error?.runnerHost, error?.lease?.runner?.host, error?.name === 'RunnerDropped' ? error.host : null, ...attempts.map(row => row?.runner)]
    .filter(host => typeof host === 'string' && host && host !== 'local');
}

/**
 * The gate cell knows no runner transport, so with no probe supplied a rerun treats an executor as healthy.
 * Why: gate sits below runners; the app that owns the transport passes its real probe (apps/lib healthyExecutor).
 */
async function anyExecutor() {
  return true;
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
 * A lock stop (LOCK_CODES) is no attempt: the same candidate waits with doubling backoff, capped at 30 s, until the
 * lock frees, and each wait adds to `lockWaits`, which the result and any thrown error carry for the job record.
 *
 * A CELLS_INVENTORY_PENDING stop that names its commit (`commit`, or `inventoryCommit` from the cells check) is no
 * attempt either: `waitInventory(commit)` waits for the producer, and when the inventory turns ready after at least one
 * poll the same candidate runs again. When it throws (the producer is dead or absent, or the wait ran out), or the
 * inventory was already ready so waiting cannot help, or INVENTORY_WAITS free waits are spent, the stop counts like any
 * other (#3316).
 *
 * @param {(attempt: number, avoided: Set<string>) => Promise<any>} run one complete attempt of the canonical submit
 * @param {{ onInfrastructure?: (rerun: { attempt: number, code: string, hosts: string[], message: string }) => Promise<void>, say?: (line: string) => void, waitInventory?: (commit: string) => Promise<unknown>, healthy?: () => Promise<boolean>, wait?: (ms: number) => Promise<void>, pauseMs?: number, noRunnerPauseMs?: number, retries?: number, lockPauseMs?: number, lockMaxPauseMs?: number, lockWaitLimit?: number }} [options]
 * @returns {Promise<{ result: any, attempts: Array<{ attempt: number, code: string, message: string, hosts: string[] }>, avoided: string[], lockWaits: { count: number, totalMs: number, codes: Record<string, number> } }>}
 */
export async function submitUntilSettled(run, { say = () => {}, waitInventory = null, healthy = anyExecutor, wait = pause, pauseMs = PAUSE_MS, noRunnerPauseMs = NO_RUNNER_PAUSE_MS, retries = INFRA_RETRIES, onInfrastructure = async () => {}, lockPauseMs = LOCK_PAUSE_MS, lockMaxPauseMs = LOCK_MAX_PAUSE_MS, lockWaitLimit = LOCK_WAIT_LIMIT } = {}) {
  const attempts = [];
  const lockWaits = { count: 0, totalMs: 0, codes: {} };
  let avoided = new Set();
  let inventoryWaits = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await withAvoidedRunners(avoided, () => run(attempt, avoided));
      return { result, attempts, avoided: [...avoided], lockWaits };
    } catch (error) {
      if (lockWaits.count && error && typeof error === 'object' && Object.isExtensible(error)) error.lockWaits = lockWaits;
      const code = infrastructureFailure(error) ?? (error?.retryable === true ? String(error.code ?? 'RETRYABLE') : null);
      if (!code) throw error;
      if (LOCK_CODES.has(code)) {
        if (lockWaits.count >= lockWaitLimit) {
          attempts.push({ attempt, code, message: String(error.message ?? '').slice(0, 500), hosts: [] });
          throw exhausted(attempts, error);
        }
        const ms = Math.min(lockPauseMs * 2 ** Math.min(lockWaits.count, 16), lockMaxPauseMs);
        lockWaits.count += 1;
        lockWaits.totalMs += ms;
        lockWaits.codes[code] = (lockWaits.codes[code] ?? 0) + 1;
        say(`queued gate met a busy lock (${code}); waiting ${Math.round(ms / 1000)} s and continuing the same candidate, not a retry`);
        await wait(ms);
        continue;
      }
      const inventoryCommit = typeof error.commit === 'string' ? error.commit : error.inventoryCommit;
      if (code === 'CELLS_INVENTORY_PENDING' && typeof inventoryCommit === 'string' && waitInventory && inventoryWaits < INVENTORY_WAITS) {
        inventoryWaits += 1;
        say(`queued gate is waiting for the accepted cells inventory of ${inventoryCommit.slice(0, 12)}; continuing the same candidate, not a retry`);
        let ready = null;
        try { ready = await waitInventory(inventoryCommit); }
        catch (waitError) { say(`queued gate stopped waiting: ${String(waitError?.message ?? waitError).split('\n')[0]}`); }
        // Ready on the first poll means waiting changed nothing, so the stop counts and the loop stays finite.
        if (ready && Number(ready.waited) > 0) { attempt -= 1; continue; }
      }
      const hosts = [...new Set(failedHosts(error))];
      attempts.push({ attempt, code, message: String(error.message ?? '').slice(0, 500), hosts });
      // A spent gate retry window (30 min across runners) is the whole retry: stop now, and the board shouts once (#3365).
      if (error.infrastructureWindowSpent === true) throw Object.assign(exhausted(attempts, error), { windowSpent: true });
      if (attempts.length > retries) throw exhausted(attempts, error);
      // Only the last attempt's failed hosts are avoided: an earlier host that recovered re-enters the pool.
      avoided = new Set(hosts);
      // The board hears each rerun's code once, before the rerun is admitted, so a cause is never left to the log (#3071).
      await onInfrastructure({ attempt, code, hosts, message: String(error.message ?? '').slice(0, 500) });
      const away = avoided.size ? `, avoiding ${[...avoided].join(', ')}` : '';
      say(`queued gate attempt ${attempt} hit an infrastructure failure (${code}${hosts.length ? ` on ${hosts.join(', ')}` : ''}): ${String(error.message ?? '').split('\n')[0]}; requeueing the same candidate${away}, not a red`);
      let waits = 0;
      while (!(await healthy())) {
        if (++waits > HEALTH_WAITS) throw exhausted(attempts, error);
        say(`no healthy runner or local gate slot yet; the candidate waits in the queue and retries in ${Math.round(noRunnerPauseMs / 1000)} s`);
        await wait(noRunnerPauseMs);
      }
      await wait(Math.min(pauseMs * attempts.length, 6 * pauseMs));
    }
  }
}

/** The infrastructure stop after the retries are spent: the coordinator's to resolve, never the builder's red. */
function exhausted(attempts, cause) {
  const last = attempts.at(-1);
  // The last stop's own first line stays in the refusal, so a policy change or a runner fault is never reduced to its code [C7].
  const detail = String(last.message ?? '').split('\n')[0].trim();
  return Object.assign(new Refused('GATE_INFRA_EXHAUSTED', `the gate stopped on infrastructure ${attempts.length} times (last ${last.code}${last.hosts.length ? ` on ${last.hosts.join(', ')}` : ''}${detail ? `: ${detail}` : ''}); nothing is wrong with the candidate`,
    'nothing to do as the builder: the coordinator restores the named runner and requeues this gate'), { attempts, cause, ...(cause?.lockWaits ? { lockWaits: cause.lockWaits } : {}) });
}
