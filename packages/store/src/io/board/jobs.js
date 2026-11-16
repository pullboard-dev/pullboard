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
  CREATE INDEX IF NOT EXISTS job_step_lease ON job (job_step, job_lease_until);
  CREATE INDEX IF NOT EXISTS job_lease_live ON job (job_lease_until) WHERE job_lease_owner IS NOT NULL;
  CREATE INDEX IF NOT EXISTS job_step_name_seq ON job_step (job_step_name, job_step_seq);
  CREATE INDEX IF NOT EXISTS job_step_name_at ON job_step (job_step_name, job_step_at);
`;

/**
 * The board's one row per runner job a move decides on: its id, kind, item, state, outcome, receipt summary and
 * hand-off record [B2,R2]. Additive like the job tables; run ids are never reused. Runner traffic itself lives in the
 * runs file (~/pbseat/coord/runner-store-design.md, section 1), so this table stays small.
 */
export const RUN_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS run (
    run_job TEXT PRIMARY KEY,
    run_kind TEXT NOT NULL,
    run_item INTEGER,
    run_candidate TEXT,
    run_base TEXT,
    run_state TEXT NOT NULL,
    run_attempt INTEGER NOT NULL DEFAULT 0,
    run_outcome TEXT,
    run_summary TEXT,
    run_record TEXT,
    run_lease_owner TEXT,
    run_lease_until INTEGER NOT NULL DEFAULT 0,
    run_created INTEGER NOT NULL,
    run_updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_item_kind ON run (run_item, run_kind);
  CREATE INDEX IF NOT EXISTS run_open ON run (run_state) WHERE run_state IN ('queued', 'awaiting');
`;

/** The run table and its indexes; a board missing any of them gains them on its next owning open [B2]. */
export const RUN_OBJECT_NAMES = ['run', 'run_item_kind', 'run_open'];

/** The job indexes the board API's queries rely on; a board missing any of them upgrades on its next open [C7,#6722]. */
export const JOB_INDEX_NAMES = ['job_kind_item', 'job_step_lease', 'job_lease_live', 'job_step_name_seq', 'job_step_name_at'];

/**
 * True when either job table is not installed yet.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function missingJobTables(db) {
  const have = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('job', 'job_step')").all();
  // The item index serves every per-item hand-off read (claim, next, list), so a board without it upgrades too [C7].
  return have.length < 2 || !JOB_INDEX_NAMES.every(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name))
    || !RUN_OBJECT_NAMES.every(name => db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name))
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
 * Install the job tables and the board's run table.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureJobTables(db) {
  db.exec(JOB_SCHEMA_SQL);
  db.exec(RUN_SCHEMA_SQL);
  adoptLegacyHandoffs(db);
}
