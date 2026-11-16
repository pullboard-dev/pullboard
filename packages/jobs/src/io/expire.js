/** Expire queued jobs nobody can claim and nobody waits on [C7]. */
import { queuedExpired } from '../logic/rules.js';
import { QUEUED_EXPIRY_MS } from '../logic/rules.js';
import { endJob } from './lease.js';

/**
 * End each job still in `queued` past its kind's limit, with an `expired` step that records why. A job something still
 * waits on (touchLive within the limit) stays, and so does every offered, claimed or done job.
 *
 * Why: 592 of 643 queued rows were days old and could never be claimed, hiding the 51 that were real (15 Nov).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: number}} [options]
 * @returns {{id: string, kind: string, quietMs: number}[]} the jobs expired, oldest first
 */
export function expireQueuedJobs(db, { now = Date.now() } = {}) {
  const kinds = Object.keys(QUEUED_EXPIRY_MS);
  const rows = db.prepare(`SELECT job.job_id AS id, job.job_kind AS kind, MAX(job.job_created, COALESCE((SELECT job_step_at FROM job_step WHERE job_step_job = job.job_id AND job_step_name = 'alive' AND job_step_seq = 0), 0)) AS quiet
    FROM job WHERE job.job_step = 'queued' AND job.job_lease_owner IS NULL AND job.job_kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY job.job_created, job.job_id`).all(...kinds);
  const expired = [];
  for (const row of rows) {
    if (!queuedExpired(row.kind, row.quiet, now)) continue;
    const quietMs = now - row.quiet;
    const reason = `queued ${Math.round(quietMs / 3_600_000)} h with nobody waiting, past the ${Math.round(QUEUED_EXPIRY_MS[row.kind] / 3_600_000)} h limit for ${row.kind}`;
    if (endJob(db, row.id, 'expired', { reason, kind: row.kind, quietMs, limitMs: QUEUED_EXPIRY_MS[row.kind] }, { now })) expired.push({ id: row.id, kind: row.kind, quietMs });
  }
  return expired;
}
