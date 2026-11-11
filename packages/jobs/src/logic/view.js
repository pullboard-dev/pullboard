/** Pure shaping of job rows into the view every reader shares [C7]. */

/**
 * Shape one job row and its step rows into the job view.
 *
 * Why: the current step is the last step written (or `done`, the terminal mark a finished driver puts on the row), so `show`, `status` and a resumed driver all read one answer.
 *
 * @param {Record<string, any>} job - A `job` table row.
 * @param {Record<string, any>[]} steps - Its `job_step` rows, oldest first.
 * @param {(text: string) => any} [parse] - Reads a payload text; the store passes one that fetches blob payloads.
 * @returns {{id: string, kind: string, item: number|null, candidate: string|null, base: string|null, step: string, attempt: number, leaseOwner: string|null, leaseUntil: number, created: number, updated: number, steps: {name: string, seq: number, payload: any, at: number}[]}}
 */
export function viewOf(job, steps, parse = JSON.parse) {
  return {
    id: job.job_id,
    kind: job.job_kind,
    item: job.job_item ?? null,
    candidate: job.job_candidate ?? null,
    base: job.job_base ?? null,
    step: job.job_step === 'done' ? 'done' : steps.length ? steps[steps.length - 1].job_step_name : job.job_step,
    attempt: job.job_attempt,
    leaseOwner: job.job_lease_owner ?? null,
    leaseUntil: job.job_lease_until,
    created: job.job_created,
    updated: job.job_updated,
    steps: steps.map(row => ({ name: row.job_step_name, seq: row.job_step_seq, payload: parse(row.job_step_payload), at: row.job_step_at })),
  };
}
