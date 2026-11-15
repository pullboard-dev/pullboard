/** The one blocking sleep: every synchronous wait calls this entry point, so a second Atomics.wait is a registry failure [C7,#6752]. */

/**
 * Block this thread for `ms` milliseconds without spinning.
 * Why: a few synchronous paths (lock retries, release steps) cannot await; each one calls here instead of owning an Atomics.wait.
 *
 * @param {number} ms - Milliseconds to block; zero or less returns at once.
 * @returns {void}
 */
export function sleepBlocking(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
