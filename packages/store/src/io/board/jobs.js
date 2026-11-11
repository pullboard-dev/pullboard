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
  CREATE INDEX IF NOT EXISTS job_kind_item ON job (job_kind, job_item);
`;

/**
 * True when either job table is not installed yet.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function missingJobTables(db) {
  const have = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('job', 'job_step')").all();
  // The item index serves every per-item hand-off read (claim, next, list), so a board without it upgrades too [C7].
  return have.length < 2 || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='job_kind_item'").get()
    || legacyHandoffsWaiting(db);
}

/** The board_meta key ranges older releases kept hand-off records under: the current record, then ended ones. */
const LEGACY_RANGES = [['submit_handoff_ended:', 'submit_handoff_ended;'], ['submit_handoff:', 'submit_handoff;']];

/**
 * True when board_meta still holds a hand-off record an older release wrote there. A key-range read, so it is cheap
 * on every owning open.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function legacyHandoffsWaiting(db) {
  return LEGACY_RANGES.some(([from, to]) => db.prepare('SELECT 1 FROM board_meta WHERE meta_key >= ? AND meta_key < ? LIMIT 1').get(from, to));
}

/**
 * Move every hand-off record board_meta still holds onto its gate job as a step carrying the record, then delete the
 * board_meta row. Ended records go first, so the item's current record is its newest step. A job that already holds
 * a record step (the copy saved since #3474) keeps its own steps.
 *
 * Why: the job tables are the one place the hand-off record lives (#3476); a board upgraded mid-gate must still
 * read its queued, running and red records after the board_meta copy is gone.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: number }} [options]
 * @returns {number} How many records were moved.
 */
export function adoptLegacyHandoffs(db, { now = Date.now() } = {}) {
  let moved = 0;
  const holds = db.prepare("SELECT 1 FROM job_step WHERE job_step_job = ? AND json_extract(job_step_payload, '$.record') IS NOT NULL LIMIT 1");
  const count = db.prepare('SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = ?');
  for (const [from, to] of LEGACY_RANGES) {
    for (const row of db.prepare('SELECT meta_key, meta_value FROM board_meta WHERE meta_key >= ? AND meta_key < ? ORDER BY rowid').all(from, to)) {
      let record = null;
      try { record = JSON.parse(row.meta_value); } catch { record = null; }
      const item = from === 'submit_handoff:' ? Number(row.meta_key.slice(from.length)) : record?.item ?? null;
      if (record && typeof record.id === 'string' && typeof record.state === 'string' && !holds.get(record.id)) {
        const at = Number.isFinite(Date.parse(record.completedAt ?? record.startedAt ?? record.at ?? '')) ? Date.parse(record.completedAt ?? record.startedAt ?? record.at) : now;
        const owner = Number.isSafeInteger(item) ? item : db.prepare("SELECT job_item FROM job WHERE job_id = ?").get(record.id)?.job_item ?? null;
        db.prepare('INSERT OR IGNORE INTO job (job_id, job_kind, job_item, job_candidate, job_base, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(record.id, 'gate', owner, record.commit ?? null, record.main ?? null, at, at);
        const payload = { agent: record.agentId, commit: record.commit, tree: record.tree, digest: record.digest, record };
        db.prepare('INSERT OR IGNORE INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, ?, ?, ?)')
          .run(record.id, record.state, count.get(record.id, record.state).n, JSON.stringify(payload), at);
        db.prepare('UPDATE job SET job_step = ?, job_updated = ? WHERE job_id = ?').run(record.state, at, record.id);
        moved += 1;
      }
      db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(row.meta_key);
    }
  }
  return moved;
}

/**
 * Install the job tables.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureJobTables(db) {
  db.exec(JOB_SCHEMA_SQL);
  adoptLegacyHandoffs(db);
}
