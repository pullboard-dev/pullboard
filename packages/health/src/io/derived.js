/** The derived-state sweep: holds keyed by main commit, in a rebuildable SQLite file beside the board [C7,#8944]. */
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The derived file's path beside a board file: `<board file>.derived-state.sqlite`. */
export function derivedStatePath(boardFile) {
  return join(dirname(boardFile), `${basename(boardFile)}.derived-state.sqlite`);
}

/**
 * Write the board's holds for one main commit to the derived file, replacing any rows that commit and kind already had.
 * Why: a derived file is rebuilt from the board, so the board database is only read here, never written, and a rerun at the same commit gives the same rows [C7,#8944].
 * With health.derivedState off (`enabled` not true) it writes no file at all; the caller reads that setting and hands in the board's item reader,
 * so this file loads no other cell.
 *
 * @param {any} board - An open file-backed board.
 * @param {{ mainCommit: string, enabled: boolean, listItems: (board: any) => any[] }} options - The main commit the rows are keyed by, the health.derivedState setting, and the board's item reader.
 * @returns {{ file: string, kind: 'hold', rows: number } | null} What was written, or null when the setting is off or the board is not a file.
 */
export function sweepDerivedHolds(board, { mainCommit, enabled, listItems }) {
  if (enabled !== true) return null;
  const boardFile = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!boardFile) return null;
  const holds = listItems(board).filter(item => item.item_hold_at)
    .map(item => ({ key: String(item.item_id), value: JSON.stringify({ reason: item.item_hold_reason ?? null, at: item.item_hold_at }) }));
  const file = derivedStatePath(boardFile);
  const derived = new DatabaseSync(file);
  try {
    derived.exec('CREATE TABLE IF NOT EXISTS derived_state(main_commit TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(main_commit, kind, key)) WITHOUT ROWID');
    derived.exec('BEGIN');
    derived.prepare("DELETE FROM derived_state WHERE main_commit = ? AND kind = 'hold'").run(mainCommit);
    const insert = derived.prepare("INSERT INTO derived_state(main_commit, kind, key, value) VALUES (?, 'hold', ?, ?)");
    for (const hold of holds) insert.run(mainCommit, hold.key, hold.value);
    derived.exec('COMMIT');
  } finally { derived.close(); }
  return { file, kind: 'hold', rows: holds.length };
}
