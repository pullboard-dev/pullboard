/**
 * An infrastructure failure requeues the same queued candidate; only a test or check failure goes red [C7].
 *
 * The loop itself lives in the gate cell; this module adds the runner health probe that only the app may use,
 * because gate sits below runners (see packages/gate/src/io/requeue.js for the rules and their why).
 */
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { effectiveRunners } from '../../../../../packages/runners/index.js';
import { probeRunnerTransport } from '../../../../../packages/runners/index.js';
import { submitUntilSettled as settle } from '../../../../../packages/gate/heavy.js';
import { LOCK_CODES } from '../../../../../packages/gate/heavy.js';
import { infrastructureFailure } from '../../../../../packages/gate/heavy.js';

export { INFRASTRUCTURE_CODES, INFRA_RETRIES, LOCK_CODES, LOCK_WAIT_LIMIT, INVENTORY_WAITS, infrastructureFailure } from '../../../../../packages/gate/heavy.js';

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

const IN_PLACE_PAUSE_MS = 250;
const IN_PLACE_MAX_PAUSE_MS = 5_000;
/** The longest one call waits for a lock to free, about a claim lease, before the stop goes up to the gate loop. */
const IN_PLACE_WAIT_MS = 600_000;

/** Block this thread for `ms`; a board call inside a synchronous stage cannot await. */
const sleepBlocking = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * A retry helper for the board and slot calls one submit attempt makes: a lock stop (SLOT_DB_LOCKED, BOARD_BUSY,
 * DATABASE_LOCKED) retries only the call that met it, with back-off from 250 ms doubling to 5 s, and never restarts the
 * attempt, so stages already finished are not repeated (on 6 Nov 25% of hand-off logs had a second attempt, losing a
 * median 217 stage-seconds). Any other error, and a lock still held after `waitMs`, goes up unchanged.
 *
 * The returned function takes a synchronous or asynchronous call and returns its result or promise.
 *
 * @param {{ tally?: { count: number, totalMs: number, codes: Record<string, number> }, say?: (line: string) => void, sleep?: (ms: number) => void, wait?: (ms: number) => Promise<void>, pauseMs?: number, maxPauseMs?: number, waitMs?: number }} [options]
 * @returns {<T>(call: () => T) => T}
 */
export function lockRetrier({ tally = { count: 0, totalMs: 0, codes: {} }, say = () => {}, sleep = sleepBlocking, wait = ms => new Promise(done => setTimeout(done, ms)), pauseMs = IN_PLACE_PAUSE_MS, maxPauseMs = IN_PLACE_MAX_PAUSE_MS, waitMs = IN_PLACE_WAIT_MS } = {}) {
  let waited = 0, streak = 0;
  /** The lock code of `error`, or null when the retry must not catch it or the wait is spent. */
  const lockStop = error => {
    const code = infrastructureFailure(error);
    return code && LOCK_CODES.has(code) && waited < waitMs ? code : null;
  };
  const note = code => {
    const ms = Math.min(pauseMs * 2 ** Math.min(streak++, 16), maxPauseMs);
    waited += ms; tally.count += 1; tally.totalMs += ms; tally.codes[code] = (tally.codes[code] ?? 0) + 1;
    say(`queued gate met a busy lock (${code}); waiting ${ms} ms and retrying that call, not the submit`);
    return ms;
  };
  const again = (call, first) => {
    if (first) return first.then(value => { streak = 0; return value; }, async error => {
      const code = lockStop(error);
      if (!code) throw error;
      await wait(note(code));
      return again(call);
    });
    for (;;) {
      try {
        const result = call();
        if (result && typeof result.then === 'function') return again(call, result);
        streak = 0;
        return result;
      } catch (error) {
        const code = lockStop(error);
        if (!code) throw error;
        sleep(note(code));
      }
    }
  };
  return call => again(call);
}

/**
 * Run one queued submit attempt and rerun it after an infrastructure failure, as the gate cell's loop does, with the
 * runner probe above as the default health check; a caller or fixture may pass its own `healthy`. `run` receives a third
 * argument, the in-place lock retry (lockRetrier), for the board and slot calls the attempt makes; its waits are added to
 * the result's `lockWaits`.
 *
 * @param {(attempt: number, avoided: Set<string>, inPlace: ReturnType<typeof lockRetrier>) => Promise<any>} run one complete attempt of the canonical submit
 * @param {object} [options] the gate loop's options
 */
export async function submitUntilSettled(run, options = {}) {
  const tally = { count: 0, totalMs: 0, codes: {} };
  const inPlace = lockRetrier({ tally, say: options.say, ...(options.lockSleep ? { sleep: options.lockSleep } : {}), ...(options.wait ? { wait: options.wait } : {}) });
  const settled = await settle((attempt, avoided) => run(attempt, avoided, inPlace), { ...options, healthy: options.healthy ?? healthyExecutor });
  const waits = settled.lockWaits ?? { count: 0, totalMs: 0, codes: {} };
  for (const [code, count] of Object.entries(tally.codes)) waits.codes[code] = (waits.codes[code] ?? 0) + count;
  waits.count += tally.count; waits.totalMs += tally.totalMs;
  return { ...settled, lockWaits: waits };
}
