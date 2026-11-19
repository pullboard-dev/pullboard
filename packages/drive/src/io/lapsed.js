/** The lapsed gate jobs a fallback pass may drive, read without loading the drive step machinery a pass needs only when one exists [C7,#11941]. */
import { jobView } from '../../../jobs/index.js';
import { reclaimLapsed } from '../../../jobs/index.js';
import { phaseOf } from '../logic/phase.js';
import { GATE_DRIVE_KIND } from '../logic/gate.js';

/**
 * The lapsed gate jobs a fallback pass may drive, oldest lapse first: one reclaimLapsed read, without the dispatcher
 * row (ensured, never driven) and without jobs already at their verdict.
 *
 * Why: a command that sees none opens no write handle, so `next` and `status` stay read-only on a healthy board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: number, runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on (boardRunsHolder); the jobs are read from its handle [P7,#9080].
 * @returns {{ id: string, kind: string, step: string, leaseOwner: string, lapsedMs: number }[]}
 */
export function lapsedGateJobs(db, { now = Date.now(), runs = null } = {}) {
  const jobs = runs?.db ?? db;
  return reclaimLapsed(jobs, { now }).filter((job) => {
    // A gate-drive job is listed too, so a stale one is ended; it is never driven here (#4071, SM2).
    if (job.kind !== 'gate' && job.kind !== GATE_DRIVE_KIND) return false;
    const view = jobView(jobs, job.id);
    return Boolean(view) && phaseOf(view) !== 'verdict';
  });
}
