/**
 * The job and job_step tables behind the durable gate [C7].
 *
 * Why: a gate job is a row on the board, not a process, so every step a driver takes is written before the next
 * starts. The tables are an additive upgrade (like the hot indexes): an existing board gains them on its next
 * owning open and restamps, so the schema digest and every older client stay valid.
 */

/** Columns and keys of both tables; IF NOT EXISTS keeps the statement safe to run on every open. */
export const JOB_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS job (
    job_id TEXT PRIMARY KEY,
    job_kind TEXT NOT NULL,
    job_item INTEGER,
    job_candidate TEXT,
    job_base TEXT,
    job_step TEXT NOT NULL DEFAULT 'queued',
    job_attempt INTEGER NOT NULL DEFAULT 0,
    job_lease_owner TEXT,
    job_lease_until INTEGER NOT NULL DEFAULT 0,
    job_created INTEGER NOT NULL,
    job_updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_step (
    job_step_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_step_job TEXT NOT NULL,
    job_step_name TEXT NOT NULL,
    job_step_seq INTEGER NOT NULL DEFAULT 0,
    job_step_payload TEXT NOT NULL DEFAULT '{}',
    job_step_at INTEGER NOT NULL,
    UNIQUE (job_step_job, job_step_name, job_step_seq)
  );
`;

/**
 * True when either job table is not installed yet.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function missingJobTables(db) {
  const have = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('job', 'job_step')").all();
  return have.length < 2;
}

/**
 * Install the job tables.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureJobTables(db) {
  db.exec(JOB_SCHEMA_SQL);
}
