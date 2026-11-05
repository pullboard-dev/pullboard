/**
 * A queued gate's queue entry keeps beating while its item-lease renewal is blocked [C7].
 *
 * Why: a queued gate renews its board item lease from the wait loop, and on a busy board that renewal waits in
 * SQLite's busy handler, which blocks the process's only thread. Past the 120 s gate-waiter cutoff another process's
 * queue cleanup deleted the live entry, and the renewal ended in RESOURCE_LEASE_LOST, bouncing the submit to its
 * builder (5 Nov, 62 shouts). A worker thread has its own event loop and its own connection, so it refreshes the
 * entry's heartbeat while the main thread is blocked. It beats only during a renewal, and for at most
 * LONGEST_RENEWAL_MS, so a process that is truly hung still ages out; it dies with its process, so a dead gate is
 * still cleaned up.
 */
import { Worker } from 'node:worker_threads';

/** How often the thread refreshes the heartbeat during a renewal: well inside the 120 s cleanup cutoff. */
export const RENEWAL_BEAT_MS = 5_000;
/** The longest renewal the thread keeps alive; past it a stuck renewal stops beating and its entry can age out. */
const LONGEST_RENEWAL_MS = 10 * 60_000;
/** How long an idle thread waits for the next renewal before it exits; the next renewal starts a new one. */
const IDLE_EXIT_MS = 60_000;

const SOURCE = `
const { workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { file, token, beatMs, longestMs, idleMs } = workerData;
const flag = new Int32Array(workerData.flag);
const since = new Float64Array(workerData.since);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 1000');
const touch = db.prepare('UPDATE waiter SET heartbeat = ? WHERE token = ?');
let idleSince = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  if (Atomics.load(flag, 0) === 1) {
    idleSince = now;
    if (now - since[0] < longestMs) try { touch.run(now, token); } catch { /* A busy queue keeps the last beat. */ }
  } else if (now - idleSince > idleMs) {
    clearInterval(timer);
    try { db.close(); } catch { /* Already closed. */ }
  }
}, beatMs);
`;

/** Live beat threads by waiter token. */
const threads = new Map();

/** The beat thread for one waiter, started on its first renewal. */
function thread(file, token) {
  let entry = threads.get(token);
  if (entry) return entry;
  const flag = new SharedArrayBuffer(4), since = new SharedArrayBuffer(8);
  const worker = new Worker(SOURCE, { eval: true, workerData: { file, token, flag, since, beatMs: RENEWAL_BEAT_MS,
    longestMs: LONGEST_RENEWAL_MS, idleMs: IDLE_EXIT_MS } });
  worker.unref();
  entry = { worker, flag: new Int32Array(flag), since: new Float64Array(since) };
  threads.set(token, entry);
  const forget = () => { if (threads.get(token) === entry) threads.delete(token); };
  worker.once('exit', forget);
  worker.once('error', forget);
  return entry;
}

/**
 * Run one item-lease renewal; for a queued waiter, a thread refreshes its queue heartbeat until the renewal returns.
 *
 * @template T
 * @param {string} file The slot database holding the waiter.
 * @param {string} token The waiter's lease token.
 * @param {boolean} waiting Whether the lease is still a queued waiter (an admitted holder has its own liveness rule).
 * @param {() => T | Promise<T>} renew The renewal.
 * @returns {Promise<T>}
 */
export async function renewWithBeat(file, token, waiting, renew) {
  if (!waiting) return await renew();
  let entry = null;
  try {
    entry = thread(file, token);
    entry.since[0] = Date.now();
    Atomics.store(entry.flag, 0, 1);
  } catch { entry = null; /* Without a thread the renewal runs as before. */ }
  try { return await renew(); }
  finally { if (entry) Atomics.store(entry.flag, 0, 0); }
}
