/** A queued gate's entry stays alive while its wait loop probes unreachable runners [C7]. */
import { beginResourceWrite } from './resource-write-lock.js';

/** How long a heartbeat waits for a busy queue before it gives up; the next poll writes a fresh one anyway. */
const TOUCH_LOCK_MS = 1_000;

/**
 * Refresh one waiter's heartbeat without the dead-lease sweep, best effort.
 * Why: a gate waiting on unreachable runners ran up to four SSH probes in a row; past 120 s the sweep in the next
 * queue update deleted its live entry, which cost its place and let a lease renewal refuse RESOURCE_LEASE_LOST.
 *
 * @param {import('node:sqlite').DatabaseSync} db The queue connection the waiter polls on.
 * @param {string} token The waiter's lease token.
 */
export function touchWaiter(db, token) {
  try { beginResourceWrite(db, { timeoutMs: TOUCH_LOCK_MS }); } catch { return; }
  try {
    db.prepare('UPDATE waiter SET heartbeat = ? WHERE token = ?').run(Date.now(), token);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* Nothing was open. */ }
  }
}

/**
 * Wrap a runner probe so the waiter's heartbeat is refreshed each time it finishes, so probes run one after another
 * never age a live queue entry. A missing probe stays missing, so recovery still skips it.
 *
 * @template {Function | undefined} T
 * @param {T} probe
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 * @returns {T}
 */
export function beatingProbe(probe, db, token) {
  if (typeof probe !== 'function') return probe;
  return /** @type {T} */ (async (...args) => {
    try { return await probe(...args); }
    finally { touchWaiter(db, token); }
  });
}

/**
 * The wait loop's runner probes from its resource options, each refreshing the waiter's heartbeat as it finishes.
 *
 * @param {{ runnerHealthProbe?: Function, runnerIdleProbe?: Function, runnerRestartProbe?: Function, runnerLeakProbe?: Function, runnerTransportProbe?: Function }} options
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 */
export function beatingProbes(options, db, token) {
  return { probe: beatingProbe(options.runnerHealthProbe, db, token), idleProbe: beatingProbe(options.runnerIdleProbe, db, token),
    restartProbe: beatingProbe(options.runnerRestartProbe, db, token), leakProbe: beatingProbe(options.runnerLeakProbe, db, token),
    transportProbe: beatingProbe(options.runnerTransportProbe, db, token) };
}
