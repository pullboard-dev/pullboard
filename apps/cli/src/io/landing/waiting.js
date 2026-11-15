/** Where each accepted, unmerged item stands with the board's own landing: in an open land job, held, or with no job [C7,#7948]. */

/**
 * The open land jobs by the item ids they name: { job, step, runner } for each, runner null until one claims it.
 * Why one read: an accept offers each item in at most one open job, and land, resume and the offer itself must agree
 * on which items a job already holds [C7,#7728].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [now] - Epoch milliseconds, to tell a live lease from a lapsed one.
 * @returns {Map<number, { job: string, step: string, runner: string | null }>}
 */
export function openLandJobs(db, now = Date.now()) {
  const rows = db.prepare(`SELECT job.job_id, job.job_step, job.job_lease_owner, job.job_lease_until, step.job_step_payload FROM job
    JOIN job_step AS step ON step.job_step_job = job.job_id AND step.job_step_name = 'offered' AND step.job_step_seq = 0
    WHERE job.job_kind = 'land' AND job.job_step <> 'done' ORDER BY job.job_created, job.job_id`).all();
  const held = new Map();
  for (const row of rows) {
    let items = [];
    try { items = JSON.parse(row.job_step_payload)?.payload?.items ?? []; } catch { /* an unreadable offer names nothing */ }
    const runner = row.job_lease_owner && row.job_lease_until >= now ? row.job_lease_owner : null;
    for (const entry of items) if (Number.isSafeInteger(entry?.id) && !held.has(entry.id)) held.set(entry.id, { job: row.job_id, step: row.job_step, runner });
  }
  return held;
}

/**
 * Each accepted, unmerged item's landing state, in the order given: `job` when an open land job names it, `held` when
 * a hold keeps it out of landing, else `none`, which nothing will change until a land job is offered.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item_id: number, item_status: string, item_merged_commit?: string | null, item_hold_at?: string | null, item_hold_reason?: string | null }[]} items
 * @param {number} [now]
 * @returns {{ id: number, state: 'job' | 'held' | 'none', job?: string, step?: string, runner?: string | null, reason?: string }[]}
 */
export function landingWaits(db, items, now = Date.now()) {
  const jobs = openLandJobs(db, now);
  return items.filter(item => item.item_status === 'verified' && !item.item_merged_commit).map(item => {
    const open = jobs.get(item.item_id);
    if (open) return { id: item.item_id, state: 'job', ...open };
    if (item.item_hold_at) return { id: item.item_id, state: 'held', reason: String(item.item_hold_reason ?? 'held').split('\n')[0] };
    return { id: item.item_id, state: 'none' };
  });
}

/** One line naming where an accepted item waits and the step that moves it. */
export function landingWaitLine(wait) {
  if (wait.state === 'job') {
    return `#${wait.id} waits in land job ${wait.job} (${wait.step}${wait.runner ? `, claimed by runner ${wait.runner}` : ', no runner has claimed it yet'}); a runner merges and pushes it, so nothing is needed by hand`;
  }
  if (wait.state === 'held') return `#${wait.id} is accepted but held: ${wait.reason}; next: fix it on current main and resubmit, or pullboard hold ${wait.id} --off`;
  return `#${wait.id} is accepted and no land job names it; next: pullboard land offers it`;
}
