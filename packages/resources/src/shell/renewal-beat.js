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
/** The idle and beat timings in force; a test shortens them through `tuneRenewalBeat`. */
const timing = { beatMs: RENEWAL_BEAT_MS, idleMs: IDLE_EXIT_MS };

/**
 * Shorten the thread's timings so a test reaches its retirement quickly.
 *
 * @param {{beatMs?: number, idleMs?: number}} [next] Timings to use for threads started after this call; none restores the defaults.
 * @returns {void}
 */
export function tuneRenewalBeat(next = {}) {
  timing.beatMs = next.beatMs ?? RENEWAL_BEAT_MS;
  timing.idleMs = next.idleMs ?? IDLE_EXIT_MS;
}

/** Flag states: the thread waits, beats during a renewal, or has claimed its own retirement. */
const IDLE = 0, BEATING = 1, RETIRING = 2;

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
  if (Atomics.load(flag, 0) === ${BEATING}) {
    idleSince = now;
    if (now - since[0] < longestMs) try { touch.run(now, token); } catch { /* A busy queue keeps the last beat. */ }
  } else if (now - idleSince > idleMs) {
    // Claim retirement atomically: a renewal that starts first wins and the thread stays; one that loses starts a new thread.
    if (Atomics.compareExchange(flag, 0, ${IDLE}, ${RETIRING}) !== ${IDLE}) return;
    clearInterval(timer);
    try { db.close(); } catch { /* Already closed. */ }
  }
}, beatMs);
`;

/** Live beat threads by waiter token. */
const threads = new Map();
/** Tokens whose thread died on an error: their renewals run unbeaten, since respawning per renewal is a crash loop. */
const failed = new Set();

/**
 * The beat thread for one waiter, started on its first renewal.
 *
 * A cached thread that has retired, or is retiring, after its idle timeout is dropped and replaced: its exit event may
 * not have reached this thread yet, and a renewal that began on it would run with no heartbeat.
 */
function thread(file, token) {
  if (failed.has(token)) throw new Error('the beat thread for this waiter failed');
  let entry = threads.get(token);
  if (entry && Atomics.load(entry.flag, 0) !== RETIRING) return entry;
  if (entry) threads.delete(token);
  const flag = new SharedArrayBuffer(4), since = new SharedArrayBuffer(8);
  // The source is CommonJS: a worker inherits its parent's execArgv, and a parent started with --input-type=module made
  // this one parse it as a module, die on `require`, and respawn at every renewal, 25 a second, in the runners' job
  // journals (#4899).
  const worker = new Worker(SOURCE, { eval: true, execArgv: [], workerData: { file, token, flag, since, beatMs: timing.beatMs,
    longestMs: LONGEST_RENEWAL_MS, idleMs: timing.idleMs } });
  worker.unref();
  entry = { worker, flag: new Int32Array(flag), since: new Float64Array(since) };
  threads.set(token, entry);
  const forget = () => { if (threads.get(token) === entry) threads.delete(token); };
  worker.once('exit', forget);
  worker.once('error', () => { if (failed.size > 4096) failed.clear(); failed.add(token); forget(); });
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
    // Start beating only if the thread is not retiring; if it claimed retirement just now, take a fresh one.
    if (Atomics.compareExchange(entry.flag, 0, IDLE, BEATING) === RETIRING) {
      threads.delete(token);
      entry = thread(file, token);
      entry.since[0] = Date.now();
      Atomics.store(entry.flag, 0, BEATING);
    }
  } catch { entry = null; /* Without a thread the renewal runs as before. */ }
  try { return await renew(); }
  finally { if (entry) Atomics.compareExchange(entry.flag, 0, BEATING, IDLE); }
}
