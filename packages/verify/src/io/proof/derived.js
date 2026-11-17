/** The derived database beside a board: proof counters written there as well as to board_meta, when the setting is on [C7]. */
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';

/** The setting that turns the dual write on; off unless it is exactly "1". */
export const DERIVED_SETTING = 'PULLBOARD_PROOF_DERIVED_DB';
/** The schema name the derived file is attached under. */
const SCHEMA = 'proof_derived';
/** Boards whose derived file is attached, by connection. */
const ATTACHED = new WeakMap();
/** The prepared multi-row upsert, by connection and pair count: preparing it per call made a 100,000-event replay on a file board ~30x slower [C7]. */
const PUT = new WeakMap();
/** Pairs a single multi-row upsert carries. */
const CHUNK = 100;

/** The derived file's path beside a board file: `<board file>.proof-derived.sqlite`, the way the presence database sits beside it. */
export function derivedPath(boardFile) {
  return join(dirname(boardFile), `${basename(boardFile)}.proof-derived.sqlite`);
}

/**
 * Attach the derived database to the board's connection and return its schema name, or null when the setting is off or the
 * board is not a file. Why: one connection writes both stores in the same transaction, so the two never disagree mid-event.
 */
function attached(board) {
  if (process.env[DERIVED_SETTING] !== '1') return null;
  if (ATTACHED.has(board.db)) return ATTACHED.get(board.db);
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  const schema = file ? SCHEMA : null;
  if (schema) {
    board.db.prepare(`ATTACH DATABASE ? AS ${SCHEMA}`).run(derivedPath(file));
    board.db.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.proof_counter(meta_key TEXT PRIMARY KEY, meta_value TEXT) WITHOUT ROWID`);
  }
  ATTACHED.set(board.db, schema);
  return schema;
}

/** Write flat key, text pairs to the derived database, as the board_meta write just did. */
export function writeDerived(board, pairs) {
  const schema = attached(board);
  if (!schema) return;
  let byCount = PUT.get(board.db);
  if (!byCount) PUT.set(board.db, byCount = new Map());
  // Budget: at most CHUNK pairs a statement keeps the cache to CHUNK shapes and stays far under SQLite's variable limit.
  for (let at = 0; at < pairs.length; at += CHUNK * 2) {
    const slice = pairs.slice(at, at + CHUNK * 2), count = slice.length / 2;
    let put = byCount.get(count);
    if (!put) {
      put = board.db.prepare(`INSERT INTO ${schema}.proof_counter(meta_key,meta_value) VALUES ${Array(count).fill('(?,?)').join(',')} ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value`);
      byCount.set(count, put);
    }
    put.run(...slice);
  }
}

/** Delete the derived rows a board_meta delete just removed: keys matching `glob` and, when given, not matching `except`. */
export function deleteDerived(board, glob, except = null) {
  const schema = attached(board);
  if (!schema) return;
  if (except) board.db.prepare(`DELETE FROM ${schema}.proof_counter WHERE meta_key GLOB ? AND meta_key NOT GLOB ?`).run(glob, except);
  else board.db.prepare(`DELETE FROM ${schema}.proof_counter WHERE meta_key GLOB ?`).run(glob);
}

/** One stored counter's text from the derived database; null when the setting is off or the row is absent. */
export function derivedText(board, storedKey) {
  const schema = attached(board);
  return schema ? board.db.prepare(`SELECT meta_value FROM ${schema}.proof_counter WHERE meta_key=?`).get(storedKey)?.meta_value ?? null : null;
}

/** Every stored counter row of the derived database, by key, for comparing totals with board_meta. */
export function derivedRows(board) {
  const schema = attached(board);
  return schema ? board.db.prepare(`SELECT meta_key, meta_value FROM ${schema}.proof_counter ORDER BY meta_key`).all() : [];
}

/** Whether this board reads and writes the derived database: the setting is on and the board is a file. */
export function derivedOn(board) {
  return attached(board) !== null;
}

/** The text of every derived row under a key prefix, in numeric id order (the order board_meta rows arrived in); empty when off. */
export function derivedTextRows(board, prefix) {
  const schema = attached(board);
  if (!schema) return [];
  const rows = board.db.prepare(`SELECT meta_key, meta_value FROM ${schema}.proof_counter WHERE meta_key GLOB ?`).all(`${prefix}*`);
  const id = row => Number(row.meta_key.slice(prefix.length));
  return rows.sort((a, b) => (id(a) - id(b)) || (a.meta_key < b.meta_key ? -1 : 1)).map(row => row.meta_value);
}

/** The text of every derived row whose key is at least `low` and below `high`, in key order; empty when off. */
export function derivedTextRange(board, low, high) {
  const schema = attached(board);
  return schema ? board.db.prepare(`SELECT meta_value FROM ${schema}.proof_counter WHERE meta_key>=? AND meta_key<? ORDER BY meta_key`).all(low, high).map(row => row.meta_value) : [];
}
