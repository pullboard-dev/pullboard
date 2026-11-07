/** Liveness of a submit hand-off worker: its worker.json record and the process it names [C7]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exactStart } from '../../../../packages/gate/src/shell/child-journal-preload.js';

/** An absent process, a different exact incarnation or a worker the dispatcher could not start proves death; unavailable identity never does. */
export function deadWorker(worker, job) {
  if (worker?.job === job.id && worker.unstarted && worker.pid === null) return true;
  if (worker?.job !== job.id || !Number.isSafeInteger(worker.pid) || worker.pid < 1) return false;
  try { process.kill(worker.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  const observed = exactStart(worker.pid);
  return Boolean(worker.started && observed && observed !== worker.started);
}

/** The job's worker record, or null while none is written. */
export function readWorkerRecord(directory) {
  try { return JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')); }
  catch { return null; }
}

/**
 * Whether a live hand-off worker process runs this job: its worker.json names the job and a process that still exists.
 *
 * Why: the gate panel must not call a running gate stalled while its worker is alive (#3444); this reuses the same
 * liveness check hand-off recovery uses, so the two never disagree about a worker.
 *
 * @param {string} commonDir - The repository's common git directory.
 * @param {{ id: string }} job - The submit hand-off record.
 * @returns {boolean}
 */
export function handoffWorkerAlive(commonDir, job) {
  const worker = readWorkerRecord(join(commonDir, 'pullboard', 'submit-handoffs', job.id));
  return Boolean(worker) && worker.job === job.id && Number.isSafeInteger(worker.pid) && worker.pid > 0 && !deadWorker(worker, job);
}
