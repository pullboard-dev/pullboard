/** The open runner jobs a claim may take, in the order it tries them: by priority class with reserves, or the plain order [C7]. */
import { DEFAULT_JOB_CLASS } from '../logic/priority.js';
import { JOB_CLASSES } from '../logic/priority.js';
import { claimOrder } from '../logic/priority.js';

/** SQL naming an offered row's priority class; a row offered without one reads as DEFAULT_JOB_CLASS. */
const CLASS = `COALESCE(json_extract(step.job_step_payload, '$.priority'), '${DEFAULT_JOB_CLASS}')`;
/** SQL ranking an offered row by its class, highest first, so the scan reads high classes before its row cap. */
const BY_CLASS = `CASE ${CLASS} ${JOB_CLASSES.map((name, index) => `WHEN '${name}' THEN ${index}`).join(' ')} ELSE ${JOB_CLASSES.length} END`;
/** The order with no reserve set: landing jobs first, then an agent's test run, then gate shards and other bulk work. */
const PLAIN = "CASE job.job_kind WHEN 'land' THEN 0 WHEN 'test' THEN 1 ELSE 2 END";

/** The jobs a runner holds a live lease on now, counted by priority class. */
function heldClasses(db, runner, now) {
  const rows = db.prepare(`SELECT ${CLASS} AS class, COUNT(*) AS held FROM job JOIN job_step AS step
    ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_lease_owner = ? AND job.job_lease_until >= ? AND job.job_step IN ('offered', 'claimed') GROUP BY class`).all(runner, now);
  return Object.fromEntries(rows.map(row => [row.class, row.held]));
}

/**
 * The open jobs this runner can run, in claim order, each with its parsed offer. A job is open while it is offered or
 * its last lease lapsed. With a reserve (gate.jobReserve) the highest class goes first and a full runner keeps each
 * class its reserved share of `slots` (claimOrder); with none, the order is PLAIN, each kind in creation order.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ runner: string, now: number, limit: number, reserve?: Record<string, number> | null, slots?: number | null, runnable?: (row: Record<string, any>, offer: Record<string, any>) => boolean }} request
 * @returns {{ row: Record<string, any>, offer: Record<string, any> }[]}
 */
export function claimableJobs(db, { runner, now, limit, reserve = null, slots = null, runnable = () => true }) {
  const open = db.prepare(`SELECT job.job_id, job.job_kind, job.job_item, job.job_candidate, job.job_base, step.job_step_payload FROM job JOIN job_step AS step
    ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_step IN ('offered', 'claimed') AND job.job_lease_until < ? ORDER BY ${reserve ? BY_CLASS : PLAIN}, job.job_created, job.job_id LIMIT ?`).all(now, limit);
  const jobs = open.map(row => ({ row, offer: JSON.parse(row.job_step_payload) })).filter(({ row, offer }) => runnable(row, offer));
  if (!reserve) return jobs;
  return claimOrder(jobs.map(job => ({ ...job, priority: job.offer.priority ?? DEFAULT_JOB_CLASS })), { reserve, slots, held: heldClasses(db, runner, now) });
}
