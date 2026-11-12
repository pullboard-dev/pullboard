/** A land job's landing permit on its claim and renewal answers, for the trunk guard (#5848) [B3,P7]. Kept apart from landing.js, which runs no git. */
import { landingPermit } from '../../../git/index.js';
import { LANDING_JOB_KIND } from './landing.js';

/**
 * Add the landing permit to a land job's claim or renewal answer: the board's receipt for that lease, which the job's
 * trunk push carries so the trunk guard accepts it (#5848). Other answers, and a board with no landing key, pass as
 * they are.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} body - The queue call.
 * @param {Record<string, any>} answer - jobQueueCall's answer to it.
 * @param {() => string | null} keyOf - The board's landing key, read only for a land job's lease.
 * @returns {Record<string, any>}
 */
export function withLandingPermit(db, body, answer, keyOf) {
  const lease = body?.action === 'claim' ? answer?.claim : body?.action === 'renew' && answer?.renewed ? { job: body.job, leaseUntil: answer.leaseUntil } : null;
  if (!lease) return answer;
  const row = db.prepare(`SELECT job.job_kind, step.job_step_payload FROM job JOIN job_step AS step ON step.job_step_job = job.job_id
    AND step.job_step_name = 'offered' AND step.job_step_seq = 0 WHERE job.job_id = ?`).get(lease.job);
  const key = row?.job_kind === LANDING_JOB_KIND ? keyOf() : null;
  if (!key) return answer;
  const { payload } = JSON.parse(row.job_step_payload);
  const fields = { job: lease.job, runner: body.runner, leaseUntil: lease.leaseUntil };
  const permit = { ...fields, mac: landingPermit(key, { ...fields, trunk: payload.trunk }) };
  return body.action === 'claim' ? { ...answer, claim: { ...answer.claim, permit } } : { ...answer, permit };
}
