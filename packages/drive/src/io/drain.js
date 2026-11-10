/** drainLoop: call driveOnce on one job until it reaches its terminal step, renewing the lease on every call [C7]. */
import { driveOnce } from './once.js';

/** How long a worker rests between drives that moved nothing: the design's 5-second lease renewal. */
export const DRAIN_INTERVAL_MS = 5000;

/**
 * Resolve after `ms` milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function rest(ms) {
  return new Promise(done => setTimeout(done, ms));
}

/**
 * Drive one job by repeated driveOnce calls until it reaches its verdict, or until another driver holds its live
 * lease. A call that moved nothing (shards still running) rests `intervalMs` first, and every call renews the lease.
 *
 * Why: the job row holds every step, so the process running this loop is never load-bearing: if it dies, the next
 * loop on the job (the respawned worker, or any driver once the lease lapses) continues from the last written step
 * and reruns no shard that has a done step.
 *
 * @param {import('node:sqlite').DatabaseSync | import('./once.js').JobRows} db - The board's SQLite handle, or job
 *   rows (rowSink) whose step, ticket and verdict rows a coordinator-side recorder writes.
 * @param {string} job - The job id.
 * @param {{ owner: string, intervalMs?: number, onStep?: (result: object) => void, drive?: typeof driveOnce }
 *   & Record<string, any>} options - The rest (repo, runner, plan, transport, sections, now) passes to driveOnce.
 * @returns {Promise<Awaited<ReturnType<typeof driveOnce>>>} The last drive: phase 'verdict', or code JOB_LEASED.
 */
export async function drainLoop(db, job, { intervalMs = DRAIN_INTERVAL_MS, onStep = () => {}, drive = driveOnce, ...options } = /** @type {any} */ ({})) {
  for (;;) {
    const result = await drive(db, job, options);
    onStep(result);
    if (result.phase === 'verdict' || result.code) return result;
    if (result.transition === null) await rest(intervalMs);
  }
}
