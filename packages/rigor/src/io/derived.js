/** The derived database for rigor counters: a file beside the board, used instead of board_meta when the setting is on [C7]. */
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';

/** The setting that moves rigor counters to the derived file; off unless exactly "1". The same setting the proof counters' derived file uses. */
export const RIGOR_DERIVED_SETTING = 'PULLBOARD_PROOF_DERIVED_DB';
/** The schema name the derived file is attached under. */
const SCHEMA = 'rigor_derived';
/** Each connection's attached schema name, or null when the counters stay in board_meta. */
const ATTACHED = new WeakMap();

/** The derived file's path beside a board file: `<board file>.rigor-derived.sqlite`. */
export function rigorDerivedPath(boardFile) {
  return join(dirname(boardFile), `${basename(boardFile)}.rigor-derived.sqlite`);
}

/**
 * The schema name of the attached derived file, attaching it on first use; null when the setting is off or the board is not a file.
 * Why: one connection reads and writes it inside the board's own savepoints, so the counters and the events never disagree mid-write.
 */
export function rigorDerived(board) {
  if (process.env[RIGOR_DERIVED_SETTING] !== '1') return null;
  if (ATTACHED.has(board.db)) return ATTACHED.get(board.db);
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  const schema = file ? SCHEMA : null;
  if (schema) {
    board.db.prepare(`ATTACH DATABASE ? AS ${SCHEMA}`).run(rigorDerivedPath(file));
    board.db.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.rigor_counter(meta_key TEXT PRIMARY KEY, meta_value TEXT) WITHOUT ROWID`);
  }
  ATTACHED.set(board.db, schema);
  return schema;
}
