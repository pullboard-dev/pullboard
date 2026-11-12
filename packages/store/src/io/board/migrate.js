/**
 * The board's column migration and the digest that says a board needs none [C7].
 *
 * Why: opening the board for every command ran the schema, 23 PRAGMA table_info and an insert under
 * the write lock, so a read waited out any writer (3.5 s behind a 3 s hold). A board stamped with
 * this code's stamp and user_version skips all of it, and a read opens the file read-only.
 */
import { createHash } from 'node:crypto';

/** Columns added after a board's first schema, in the order an older board gains them. */
const ADDED_COLUMNS = [
  ['item', 'item_after', "TEXT NOT NULL DEFAULT ''"],
  ['item', 'item_brief', "TEXT NOT NULL DEFAULT ''"],
  ['item', 'item_route', "TEXT NOT NULL DEFAULT 'strong'"],
  ['item', 'item_check', "TEXT NOT NULL DEFAULT ''"],
  ['agent', 'agent_route', "TEXT NOT NULL DEFAULT 'strong'"],
  ['agent', 'agent_family', 'TEXT'],
  ['item', 'item_builder_family', 'TEXT'],
  ['verdict', 'verdict_verifier_family', 'TEXT'],
  ['item', 'item_claim_head', 'TEXT'],
  ['item', 'item_files', "TEXT NOT NULL DEFAULT ''"],
  ['item', 'item_review_by', 'TEXT'],
  ['item', 'item_review_until', 'TEXT'],
  ['item', 'item_hold_reason', 'TEXT'],
  ['item', 'item_hold_by', 'TEXT'],
  ['item', 'item_hold_at', 'TEXT'],
  ['shout', 'shout_decision', 'INTEGER NOT NULL DEFAULT 0'],
  ['shout', 'shout_answers', 'INTEGER'],
  ['shout', 'shout_evidence_kind', 'TEXT'],
  ['shout', 'shout_evidence_outcome', 'TEXT'],
  ['shout', 'shout_evidence_item', 'INTEGER'],
  ['shout', 'shout_evidence_commit', 'TEXT'],
  ['shout', 'shout_request', 'INTEGER NOT NULL DEFAULT 0'],
  ['shout', 'shout_request_outcome', "TEXT NOT NULL DEFAULT ''"],
];

/**
 * Bring a board made by an older version up to the current schema, one added column at a time, so
 * an upgrade never needs a fresh board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function migrate(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * A digest of everything a migration applies: the schema text, the added columns and the event log
 * version. Why: a new index or column changes it, so a board stamped by older code migrates once.
 *
 * @param {string} schema
 * @param {number} eventLogVersion
 * @returns {string}
 */
export function schemaDigest(schema, eventLogVersion) {
  return createHash('sha256').update(JSON.stringify([schema, ADDED_COLUMNS, eventLogVersion])).digest('hex');
}

/**
 * A nonzero 32-bit stamp of this code's schema digest and the board's actual shape: every table,
 * index and trigger as SQLite stores it, its event log version and whether it has an id. Why: a
 * dropped index, a lost trigger or an older event log changes it, so a damaged board still heals.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} digest
 * @returns {number}
 */
function schemaStamp(db, digest, guards = null, prior = {}) {
  const shape = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .filter(entry => !prior.omitTriggers?.includes(entry.type === 'trigger' ? entry.name : null));
  if (guards) {
    const replacements = new Map(guards.map(entry => [entry.name, entry.sql]));
    const installed = shape.filter(entry => entry.type === 'trigger' && entry.name.startsWith('machine_'));
    // Missing or extra guards remain manual drift; only an exact installed-name set can recover.
    if (installed.length !== replacements.size || installed.some(entry => !replacements.has(entry.name))) return null;
    for (const entry of installed) entry.sql = replacements.get(entry.name);
  }
  const meta = shape.some((entry) => entry.type === 'table' && entry.name === 'board_meta')
    ? db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key IN ('board_id', 'event_log_version') ORDER BY meta_key").all()
      .map((entry) => (entry.meta_key === 'board_id' ? 'board_id' : prior.eventLogVersion ?? entry.meta_value))
    : [];
  return createHash('sha256').update(JSON.stringify([digest, shape, meta])).digest().readInt32BE(0) || 1;
}

/**
 * Where the board stands against this code. 'behind': its user_version or event log version is older,
 * the only case a write open migrates and audits. Otherwise its PRAGMA application_id decides:
 * 'current' when it holds the stamp of `digest` and the present shape, 'unstamped' when it was never
 * stamped, 'drifted' when the shape changed outside pullboard, which is reported and left alone.
 * Reads only, so it takes no write lock. The stamp lives in the file header, so exports never see it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} digest
 * @param {number} schemaVersion
 * @param {boolean} [logBehind] whether the event log version is older than this code's
 * @returns {'behind' | 'current' | 'unstamped' | 'drifted'}
 */
export function boardStanding(db, digest, schemaVersion, logBehind = false) {
  if (logBehind || db.prepare('PRAGMA user_version').get().user_version < schemaVersion) return 'behind';
  const stamp = db.prepare('PRAGMA application_id').get().application_id;
  return stamp === schemaStamp(db, digest) ? 'current' : stamp === 0 ? 'unstamped' : 'drifted';
}

/** True when the board carries this code's schema and stamp, so a read may trust its shape. */
export function boardIsCurrent(db, digest, schemaVersion) {
  return boardStanding(db, digest, schemaVersion) === 'current';
}

const reportedDrift = new Set();

/**
 * Say once per board file, on stderr or the caller's diagnostics, that its shape changed outside
 * pullboard at this schema version. Why once: every command opens the board, and one line is news.
 *
 * @param {string} file
 * @param {(message: string) => void} [onDiagnostic]
 */
export function reportDrift(file, onDiagnostic = (message) => process.stderr.write(`${message}\n`)) {
  if (reportedDrift.has(file)) return;
  reportedDrift.add(file);
  onDiagnostic(`pullboard: the board at ${file} has this version's schema number but a different shape (a table, index or trigger changed outside pullboard); it is left as it is`);
}

/**
 * Stamp the board once its migration and trigger audit have run.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} digest
 */
export function recordSchemaStamp(db, digest) {
  db.exec(`PRAGMA application_id = ${schemaStamp(db, digest)}`);
}

/** True when a read met a board older than this code: a column or table it does not have yet. */
export function schemaMissing(error) {
  return /no such (?:column|table)/u.test(error?.message ?? '');
}

/** True when SQLite refused a write because the board was opened read-only. */
export function writeRefused(error) {
  return (error?.errcode & 0xff) === 8;
}

/** Verify a guard-only recovery against the existing complete-shape stamp, without writing a new one. */
export function guardsMatchStoredStamp(db, digest, guards) {
  const stored = db.prepare('PRAGMA application_id').get().application_id;
  return stored !== 0 && stored === schemaStamp(db, digest, guards);
}

/** Compare one bounded prior authorized shape with the existing header, without modifying schema or metadata. */
export function priorShapeMatchesStoredStamp(db, digest, guards, prior) {
  const stored = db.prepare('PRAGMA application_id').get().application_id;
  return stored !== 0 && stored === schemaStamp(db, digest, guards, prior);
}
