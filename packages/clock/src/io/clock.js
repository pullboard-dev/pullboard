/**
 * The one place that reads Date.now and timers: callers take an adapter, tests pass a fake source [C7].
 * Why: a fake source makes time-dependent code deterministic without a wall-clock wait.
 */

/** The real source, the only place Date.now or a timer is touched. */
const REAL_SOURCE = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

/**
 * Build a clock adapter over a source of time functions.
 * @param {{ now: () => number, setTimeout: Function, clearTimeout: Function }} [source] defaults to the real clock
 * @returns {{ now: () => number, setTimeout: Function, clearTimeout: Function }}
 */
export function clockAdapter(source = REAL_SOURCE) {
  return Object.freeze({
    now: () => source.now(),
    setTimeout: (fn, ms) => source.setTimeout(fn, ms),
    clearTimeout: (handle) => source.clearTimeout(handle),
  });
}
