/** Read job slot spans, job creation times and board events for the demand view, read only [C7,#6034]. */
/** The jobs setting a claim payload carries, or null. */
function declaredJobs(text) {
  try { const jobs = JSON.parse(text)?.jobs; return Number.isSafeInteger(jobs) && jobs >= 1 ? jobs : null; } catch { return null; }
}

/**
 * Slot spans from the job tables. A job holds a slot from its first claimed (or running) step to its first
 * result or receipt step; a job still in flight with a live lease holds one until now, otherwise until its last update.
 * Jobs run locally (no claim) count under the runner "local".
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ since: number, now: number }} options - Only jobs touched at or after since are read.
 * @returns {{ spans: { job: string, kind: string, runner: string, start: number, end: number, declared: number|null }[], created: number[] }}
 */
export function readDemandSpans(db, { since, now }) {
  const jobs = db.prepare('SELECT job_id AS id, job_kind AS kind, job_step AS step, job_lease_until AS lease, job_created AS created, job_updated AS updated FROM job WHERE job_updated >= ? OR job_created >= ?').all(since, since);
  const steps = db.prepare("SELECT job_step_job AS job, job_step_name AS name, job_step_payload AS payload, job_step_at AS at FROM job_step WHERE job_step_name IN ('claimed','running','result','receipt') ORDER BY job_step_at, job_step_id").all();
  const by = new Map();
  for (const step of steps) { if (!by.has(step.job)) by.set(step.job, []); by.get(step.job).push(step); }
  const spans = [], created = [];
  for (const job of jobs) {
    if (job.created >= since) created.push(job.created);
    const list = by.get(job.id) ?? [];
    const begin = list.find(step => step.name === 'claimed') ?? list.find(step => step.name === 'running');
    if (!begin) continue;
    let runner = 'local';
    if (begin.name === 'claimed') { try { runner = JSON.parse(begin.payload)?.runner || 'local'; } catch { /* keep local */ } }
    const finish = list.find(step => (step.name === 'result' || step.name === 'receipt') && step.at >= begin.at);
    const end = finish ? finish.at : (job.step !== 'done' && job.lease >= now ? now : Math.max(job.updated, begin.at));
    if (end > since) spans.push({ job: job.id, kind: job.kind, runner, start: begin.at, end, declared: begin.name === 'claimed' ? declaredJobs(begin.payload) : null });
  }
  return { spans, created };
}

/** Board events (time and seat) at or after since. */
export function readDemandEvents(db, { since }) {
  return db.prepare('SELECT event_at AS at, event_by AS seat FROM event WHERE event_at >= ?').all(new Date(since).toISOString())
    .map(row => ({ at: Date.parse(row.at), seat: row.seat }));
}
