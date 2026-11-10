/** Progress a driven gate reports while it waits for a runner or runs tests, so its drive's stall watch sees it move [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The driver's progress callback for the gate run this async context belongs to; none outside a driven gate. */
const current = new AsyncLocalStorage();

/** How often a gate reports while a test run is in flight: well inside the drive's 2-minute progress bound. */
export const GATE_PROGRESS_MS = 60_000;

/**
 * Run `work` with `progress` as the callback every gate section under it reports to. With no callback, reports are
 * dropped, so a gate run outside a drive behaves as before.
 *
 * Why an async context: the tests section runs many calls below the hand-off worker, and the drive cell may not
 * import the gate cell; the context carries the drive's callback down without threading it through Submit (#3829).
 *
 * @template T
 * @param {((detail: { waiting?: boolean, running?: boolean }) => void) | undefined} progress
 * @param {() => T} work
 * @returns {T}
 */
export function withGateProgress(progress, work) {
  return current.run(typeof progress === 'function' ? progress : undefined, work);
}

/**
 * Report that the gate is still moving: waiting for a runner, or running tests. A callback that throws never fails
 * the gate; progress is bookkeeping.
 *
 * @param {{ waiting?: boolean, running?: boolean }} detail
 */
export function reportGateProgress(detail) {
  try { current.getStore()?.(detail); }
  catch { /* the gate goes on; a missed report only risks a stall the watch would name */ }
}

/**
 * The runner-wait callback a gate passes on: each wait poll also reports the gate waiting. Undefined stays undefined,
 * so a caller that passed no wait callback keeps its behaviour.
 *
 * @param {((state: object) => unknown) | undefined} onWait
 * @returns {((state: object) => unknown) | undefined}
 */
export function progressingWait(onWait) {
  if (!onWait) return onWait;
  return state => {
    reportGateProgress({ waiting: true });
    return onWait(state);
  };
}

/**
 * Await `work` while reporting the gate running once at the start and then every `everyMs` until it settles.
 *
 * Why a beat and not the run's own output: a runner returns results only when the run ends, so a long healthy run
 * writes nothing for its whole length; the run's own time bound still ends a run that hangs.
 *
 * @template T
 * @param {() => Promise<T>} work
 * @param {{ everyMs?: number, every?: typeof setInterval, cancel?: typeof clearInterval }} [options]
 * @returns {Promise<T>}
 */
export async function whileGateRuns(work, { everyMs = GATE_PROGRESS_MS, every = setInterval, cancel = clearInterval } = {}) {
  reportGateProgress({ running: true });
  const beat = every(() => reportGateProgress({ running: true }), everyMs);
  try { return await work(); }
  finally { cancel(beat); }
}
