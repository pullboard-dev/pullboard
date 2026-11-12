/** The board's one reading of runner capacity from pulled jobs: what each serve holds now and how many it declared it runs [C7,P7,#5993]. */

/** A serve that claimed nothing for this long no longer counts as running, so a stopped serve's setting drops out. */
export const SERVE_RECENT_MS = 10 * 60 * 1000;

/** The jobs setting a claim step carries, or null for a serve that did not say. */
function declared(text) {
  try {
    const jobs = JSON.parse(text)?.jobs;
    return Number.isSafeInteger(jobs) && jobs >= 1 ? jobs : null;
  } catch { return null; }
}

/**
 * Read per-serve claimed pulled jobs and declared jobs settings from the board's job table, plus fleet totals.
 * A job is claimed while its lease is live and its step is not done. A serve's setting comes from the claim steps it
 * posted (held jobs, or any claim within SERVE_RECENT_MS), so a serve that never claimed is unknown to the board.
 * Why one reader: the live view and ops each counted per-service registrations and showed 3 of 120 while runners ran 8 jobs each.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board, read only.
 * @param {{ now?: number }} [options]
 * @returns {{ serves: { runner: string, claimed: number, jobs: number|null }[], totals: { claimed: number, jobs: number, serves: number } }}
 */
export function readPulledCapacity(db, { now = Date.now() } = {}) {
  const serves = new Map();
  const serve = runner => { if (!serves.has(runner)) serves.set(runner, { runner, claimed: 0, jobs: null }); return serves.get(runner); };
  const note = (entry, jobs) => { if (jobs !== null && jobs > (entry.jobs ?? 0)) entry.jobs = jobs; };
  const held = db.prepare(`SELECT job.job_lease_owner AS runner, step.job_step_payload AS payload FROM job
    LEFT JOIN job_step AS step ON step.job_step_job = job.job_id AND step.job_step_name = 'claimed' AND step.job_step_seq = job.job_attempt
    WHERE job.job_lease_owner IS NOT NULL AND job.job_lease_until >= ? AND job.job_step <> 'done'`).all(now);
  for (const row of held) { const entry = serve(row.runner); entry.claimed += 1; note(entry, declared(row.payload)); }
  const recent = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_name = 'claimed' AND job_step_at >= ?").all(now - SERVE_RECENT_MS);
  for (const row of recent) {
    let runner;
    try { runner = JSON.parse(row.payload)?.runner; } catch { continue; }
    if (typeof runner === 'string' && runner) note(serve(runner), declared(row.payload));
  }
  const list = [...serves.values()].sort((a, b) => a.runner.localeCompare(b.runner));
  return { serves: list, totals: { claimed: list.reduce((sum, entry) => sum + entry.claimed, 0), jobs: list.reduce((sum, entry) => sum + (entry.jobs ?? 0), 0), serves: list.length } };
}
