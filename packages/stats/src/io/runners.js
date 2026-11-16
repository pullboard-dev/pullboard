/** Read job rows and the steps that time them, read-only, for the runner statistics [C7]. */
import { readPayload } from '../../../jobs/index.js';

/**
 * Jobs that existed at any point in a window, each with the named steps it recorded.
 *
 * Why: one reader serves every runner view; each asks for the step names it times, and for the payloads of only those
 * steps it needs to read, so nothing else is loaded.
 *
 * @param {import('node:sqlite').DatabaseSync} board
 * @param {{from: number, until: number, steps: string[], payloads?: string[], kinds?: string[], runs?: {db: import('node:sqlite').DatabaseSync | null} | null}} window - `runs`: with runs_store on, the read-only runs holder the job rows come from instead of the board [B2,#9014];  - epoch ms; `payloads` names the steps whose payload is parsed (null when it is pruned or unreadable)
 * @returns {{id: string, kind: string, item: number|null, base: string|null, step: string, attempt: number, created: number, updated: number, steps: {name: string, seq: number, at: number, payload?: any}[]}[]}
 */
export function readRunnerJobs(board, { from, until, steps, payloads = [], kinds, runs = null }) {
  const db = runs ? runs.db : board;
  if (!db) return [];
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job'").get()) return [];
  const kindMarks = kinds?.length ? ` AND j.job_kind IN (${kinds.map(() => '?').join(',')})` : '';
  const jobs = new Map(db.prepare(`SELECT j.job_id, j.job_kind, j.job_item, j.job_base, j.job_step, j.job_attempt, j.job_created, j.job_updated FROM job j
    WHERE j.job_created < ? AND j.job_updated >= ?${kindMarks}`).all(until, from, ...(kinds ?? []))
    .map(row => [row.job_id, { id: row.job_id, kind: row.job_kind, item: row.job_item, base: row.job_base, step: row.job_step, attempt: row.job_attempt, created: row.job_created, updated: row.job_updated, steps: [] }]));
  const marks = steps.map(() => '?').join(',');
  const stepRows = db.prepare(`SELECT s.job_step_job, s.job_step_name, s.job_step_seq, s.job_step_at, s.job_step_payload FROM job_step s JOIN job j ON j.job_id = s.job_step_job
    WHERE j.job_created < ? AND j.job_updated >= ? AND s.job_step_name IN (${marks})${kindMarks} ORDER BY s.job_step_id`).all(until, from, ...steps, ...(kinds ?? []));
  for (const row of stepRows) {
    const step = { name: row.job_step_name, seq: row.job_step_seq, at: row.job_step_at };
    if (payloads.includes(row.job_step_name)) {
      try { step.payload = readPayload(db, row.job_step_payload); } catch { step.payload = null; }
    }
    jobs.get(row.job_step_job)?.steps.push(step);
  }
  return [...jobs.values()];
}
