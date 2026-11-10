/** Liveness of a submit gate's driver: its drive job's row on the board and the process it names [C7]. */
import { exactStart } from '../../../../packages/gate/index.js';
import { gateDriverEnded } from '../../../../packages/drive/index.js';
import { gateDriverGone } from '../../../../packages/drive/index.js';
import { readGateDrive } from '../../../../packages/drive/index.js';

/**
 * A driver that never started or whose drive job ended proves death; so does an absent process or a different exact
 * incarnation. A lapsed lease with no process named is death too; a lapsed lease whose process is alive and the same
 * is not, and unavailable identity never is.
 *
 * Why the process decides a lapse: a blocked event loop stops renewals for minutes while the driver lives; 25 healthy
 * gates an hour were ended SUBMIT_HANDOFF_DEAD that way and later wrote their own verdicts (#3836).
 *
 * @param {ReturnType<typeof readGateDrive>} worker - The gate's driver record.
 * @param {{ id: string }} job - The submit hand-off record.
 * @param {number} [now]
 * @returns {boolean}
 */
export function deadWorker(worker, job, now = Date.now()) {
  if (worker?.job !== job.id) return false;
  if (gateDriverEnded(worker)) return true;
  if (!Number.isSafeInteger(worker.pid) || worker.pid < 1) return gateDriverGone(worker, now);
  try { process.kill(worker.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  const observed = exactStart(worker.pid);
  return Boolean(worker.started && observed && observed !== worker.started);
}

/**
 * The gate's driver record from its drive job on the board, or null while no driver was admitted.
 *
 * @param {any} board - An open board.
 * @param {{ id: string }} job - The submit hand-off record.
 * @returns {ReturnType<typeof readGateDrive>}
 */
export function readWorkerRecord(board, job) {
  return readGateDrive(board.db, job.id);
}

/**
 * Whether a live driver runs this gate: its drive job names a driver whose lease and process are alive.
 *
 * Why: the gate panel must not call a running gate stalled while its driver is alive (#3444); this reuses the same
 * liveness check hand-off recovery uses, so the two never disagree about a driver.
 *
 * @param {any} board - An open board.
 * @param {{ id: string }} job - The submit hand-off record.
 * @returns {boolean}
 */
export function handoffWorkerAlive(board, job) {
  const worker = readWorkerRecord(board, job);
  return Boolean(worker) && worker.job === job.id && worker.owner !== null && !deadWorker(worker, job);
}
