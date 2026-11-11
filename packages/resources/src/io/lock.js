/** Slot-pool reads and lease writes wait out a held SQLite lock instead of failing the gate that holds them [C7]. */
import { DatabaseSync } from 'node:sqlite';

/** How long one read or write attempt lets SQLite wait for a held lock; every pool write takes milliseconds [C7]. */
export const POOL_BUSY_TIMEOUT_MS = 2_000;
/** How long a lease write keeps retrying after SQLite's own wait, before the lock counts as stuck; it blocks the thread. */
const POOL_WRITE_RETRY_MS = 5_000;

/** Recognize SQLite's busy or locked failure, which a later attempt can pass. */
export function poolLocked(error) {
  const code = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null;
  return code === 5 || code === 6 || error?.code === 'SQLITE_BUSY' || /database is locked/iu.test(error?.message ?? '');
}

/**
 * Open the machine slot pool read-only with a busy timeout. Why: a read-only open has no timeout by default,
 * so a read during another process's write failed at once with 'database is locked' and turned gates red.
 * @param {string} file
 * @param {number} [busyMs]
 */
export function openPoolReadOnly(file, busyMs = POOL_BUSY_TIMEOUT_MS) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(busyMs))}`);
  return db;
}

/**
 * Run a lease write until it commits, retrying while the pool stays locked. Each attempt already waits
 * SQLite's busy timeout; a lock still held past the retry window is rethrown for the caller to report.
 * Why: releasing a finished run's slot is the last step of a green gate, and a busy pool must not undo it.
 * @template T
 * @param {() => T} write
 * @param {{ retryMs?: number, pause?: (ms:number) => void }} [options]
 * @returns {T}
 */
export function writeWhileLocked(write, { retryMs = POOL_WRITE_RETRY_MS, pause = sleepSync } = {}) {
  const until = Date.now() + retryMs;
  for (let delay = 50; ; delay = Math.min(delay * 2, 1_000)) {
    try { return write(); }
    catch (error) {
      if (!poolLocked(error) || Date.now() >= until) throw error;
      pause(delay);
    }
  }
}

/** Block this thread briefly between write attempts; the release path is synchronous by contract. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
