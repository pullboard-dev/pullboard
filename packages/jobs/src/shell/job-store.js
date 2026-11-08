/** Read and write job rows on the board's SQLite handle [C7]. */
import { Refused } from "../../../kernel/index.js";
import { viewOf } from "../core/job-view.js";

/**
 * Run `work` inside a savepoint so its statements land together or not at all, in or out of a transaction.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 */
function atomically(db, work) {
  db.exec('SAVEPOINT job_store');
  try {
    const result = work();
    db.exec('RELEASE job_store');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO job_store; RELEASE job_store');
    throw error;
  }
}

/**
 * Create a job in the `queued` step. Creating an id that exists returns the stored job unchanged.
 *
 * Why: enqueue can run twice (a retry, a second process); the second call must not reset a job that moved on.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: string, kind: string, item?: number|null, candidate?: string|null, base?: string|null, now?: number}} fields
 * @returns {ReturnType<typeof viewOf>}
 */
export function createJob(db, { id, kind, item = null, candidate = null, base = null, now = Date.now() }) {
  if (!id || !kind) throw new Refused('JOB_FIELDS', 'A job needs an id and a kind: pass { id, kind }.');
  db.prepare('INSERT OR IGNORE INTO job (job_id, job_kind, job_item, job_candidate, job_base, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, item, candidate, base, now, now);
  return jobView(db, id);
}

/**
 * Append a step to a job's log. A repeat of (job, name, seq) writes nothing and returns the stored payload.
 *
 * Why: a resumed driver replays steps it may already have written; the unique key makes that safe.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {string} name
 * @param {unknown} [payload] - Small JSON: commit ids, runner host, shard list, receipt ids.
 * @param {{seq?: number, now?: number}} [options]
 * @returns {{written: boolean, payload: any}}
 */
export function writeStep(db, job, name, payload = {}, { seq = 0, now = Date.now() } = {}) {
  if (!name) throw new Refused('JOB_STEP_NAME', 'A step needs a name: pass the step the driver just finished.');
  return atomically(db, () => {
    if (!db.prepare('SELECT 1 FROM job WHERE job_id = ?').get(job)) throw new Refused('JOB_MISSING', `No job ${job}: create it with createJob first.`);
    const inserted = db.prepare('INSERT OR IGNORE INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, ?, ?, ?)')
      .run(job, name, seq, JSON.stringify(payload ?? {}), now);
    if (inserted.changes === 0) {
      const stored = db.prepare('SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = ? AND job_step_seq = ?').get(job, name, seq);
      return { written: false, payload: JSON.parse(stored.job_step_payload) };
    }
    db.prepare('UPDATE job SET job_step = ?, job_updated = ? WHERE job_id = ?').run(name, now, job);
    return { written: true, payload: payload ?? {} };
  });
}

/**
 * The job and its steps, with the current step being the last one written; null when the job does not exist.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @returns {ReturnType<typeof viewOf> | null}
 */
export function jobView(db, job) {
  const row = db.prepare('SELECT * FROM job WHERE job_id = ?').get(job);
  if (!row) return null;
  return viewOf(row, db.prepare('SELECT * FROM job_step WHERE job_step_job = ? ORDER BY job_step_id').all(job));
}

/**
 * Every job of one kind, optionally for one item, oldest first, each as its job view.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{kind: string, item?: number|null}} filter
 * @returns {ReturnType<typeof viewOf>[]}
 */
export function jobsOf(db, { kind, item = null }) {
  if (!kind) throw new Refused('JOB_FIELDS', 'Listing jobs needs a kind: pass { kind }.');
  const rows = item === null
    ? db.prepare('SELECT job_id FROM job WHERE job_kind = ? ORDER BY job_created, job_id').all(kind)
    : db.prepare('SELECT job_id FROM job WHERE job_kind = ? AND job_item = ? ORDER BY job_created, job_id').all(kind, item);
  return rows.map(row => jobView(db, row.job_id));
}
