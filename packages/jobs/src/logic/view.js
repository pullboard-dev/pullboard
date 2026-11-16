/** Pure shaping of job rows into the view every reader shares [C7]. */

/**
 * The current step: `done` once finished; else the last step written, except a `released` one or a posted artifact, which is a lease handed back and not progress, so the job reads as the step it kept.
 * Why: a stopped runner releases its claim with a backoff, and every view of the job still reads it as claimed [C7].
 */
function currentStep(job, steps) {
  if (job.job_step === 'done') return 'done';
  const worked = steps.filter(step => !step.job_step_name.startsWith('artifact:') && !step.job_step_name.startsWith('note:')); // a posted artifact or a lease note is a keepsake, never a move of the job
  const last = worked.length ? worked[worked.length - 1].job_step_name : job.job_step;
  return last === 'released' ? job.job_step : last;
}

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
    step: currentStep(job, steps),
    attempt: job.job_attempt,
    leaseOwner: job.job_lease_owner ?? null,
    leaseUntil: job.job_lease_until,
    created: job.job_created,
    updated: job.job_updated,
    steps: steps.map(row => ({ name: row.job_step_name, seq: row.job_step_seq, payload: parse(row.job_step_payload), at: row.job_step_at })),
  };
}
