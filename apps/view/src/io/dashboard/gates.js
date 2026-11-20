/** The gate jobs behind the Dashboard's In the gate column: each item's newest gate job with its steps, for the click-to-open gate trace [C7,N26]. */
import { existsSync } from 'node:fs';

/** Gate jobs older than this are not the gate an item sits in now. */
const WINDOW_MS = 4 * 3_600_000;

/** At most this many items carry a trace, so a busy board's snapshot stays small. */
const MOST_ITEMS = 60;

/** Steps the trace never shows: a keepsake is not work, and the liveness and progress rows are rewritten in place rather than started. */
const NOT_PHASES = "job_step_name NOT LIKE 'artifact:%' AND job_step_name NOT LIKE 'note:%' AND job_step_name NOT IN ('alive', 'progress')";

/** The two payload fields a trace reads (when a step's work ended, which shard it was); anything else, or a stored blob, is dropped. */
function slim(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? { endedAt: value.endedAt, shard: value.shard } : null;
  } catch { return null; }
}

/**
 * Each item's newest gate job from the last four hours, as the plain job view `gateTrace` takes: id, item, step, created,
 * updated and steps with name, seq, payload and `at` in ms. Reads only; a board with no job table or no readable file has none.
 *
 * @param {string} boardFile - The board's database file.
 * @param {number} now - The snapshot clock in milliseconds.
 * @param {{ open: (file: string) => import('node:sqlite').DatabaseSync, jobsFor: (db: import('node:sqlite').DatabaseSync, file: string) => { jobs: import('node:sqlite').DatabaseSync, close: () => void } }} reader - The store's read-only open and the handle that holds the job rows.
 * @returns {Record<string, { id: string, item: number, step: string, created: number, updated: number, steps: { name: string, seq: number, payload: object|null, at: number }[] }>}
 */
export function readGateJobs(boardFile, now, { open, jobsFor }) {
  const found = {};
  let db = null, handle = null;
  try {
    if (!existsSync(boardFile)) return found;
    db = open(boardFile);
    handle = jobsFor(db, boardFile);
    const jobs = handle.jobs;
    const rows = jobs.prepare("SELECT job_id, job_item, job_step, job_created, job_updated FROM job WHERE job_kind = 'gate' AND job_item IS NOT NULL AND job_updated > ? ORDER BY job_created DESC, job_id DESC LIMIT 400").all(now - WINDOW_MS);
    const steps = jobs.prepare(`SELECT job_step_name, job_step_seq, job_step_payload, job_step_at FROM job_step WHERE job_step_job = ? AND ${NOT_PHASES} ORDER BY job_step_id LIMIT 300`);
    for (const row of rows) {
      if (found[row.job_item] || Object.keys(found).length >= MOST_ITEMS) continue;
      found[row.job_item] = { id: row.job_id, item: row.job_item, step: row.job_step, created: row.job_created, updated: row.job_updated,
        steps: steps.all(row.job_id).map(step => ({ name: step.job_step_name, seq: step.job_step_seq, payload: slim(step.job_step_payload), at: step.job_step_at })) };
    }
  } catch { /* A board with no job table has no gate to trace. */ } finally {
    try { handle?.close(); } catch { /* Already closed. */ }
    try { db?.close(); } catch { /* Already closed. */ }
  }
  return found;
}
