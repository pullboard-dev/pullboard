/** The derived-state sweep: holds, verdict freshness and accept order keyed by main commit, in a rebuildable SQLite file beside the board [C7,#8944]. */
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The derived file's path beside a board file: `<board file>.derived-state.sqlite`. */
export function derivedStatePath(boardFile) {
  return join(dirname(boardFile), `${basename(boardFile)}.derived-state.sqlite`);
}

/** The board file behind an open file-backed board, or null when it is in memory. */
function boardFileOf(board) {
  return board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file ?? null;
}

/**
 * Replace the derived rows of one main commit and kind, in one transaction.
 * Why: a rerun at the same commit gives the same rows, and another commit's rows are never touched [C7,#8944].
 */
function writeRows(boardFile, mainCommit, kind, rows) {
  const file = derivedStatePath(boardFile);
  const derived = new DatabaseSync(file);
  try {
    derived.exec('CREATE TABLE IF NOT EXISTS derived_state(main_commit TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(main_commit, kind, key)) WITHOUT ROWID');
    derived.exec('BEGIN');
    derived.prepare('DELETE FROM derived_state WHERE main_commit = ? AND kind = ?').run(mainCommit, kind);
    const insert = derived.prepare('INSERT INTO derived_state(main_commit, kind, key, value) VALUES (?, ?, ?, ?)');
    for (const row of rows) insert.run(mainCommit, kind, row.key, row.value);
    derived.exec('COMMIT');
  } finally { derived.close(); }
  return { file, kind, rows: rows.length };
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
  const boardFile = boardFileOf(board);
  if (!boardFile) return null;
  const holds = listItems(board).filter(item => item.item_hold_at)
    .map(item => ({ key: String(item.item_id), value: JSON.stringify({ reason: item.item_hold_reason ?? null, at: item.item_hold_at }) }));
  return writeRows(boardFile, mainCommit, 'hold', holds);
}

/**
 * Write each accepted, unlanded item's verdict freshness and its accept order for one main commit to the derived file [C7,#8944,#8976].
 * Why: `next` and the lander recompute both on every read; keyed by main commit, a new commit gets its own rows and the old commit's rows are never read again.
 * Freshness is whatever the caller's `verdictState` returns for the item (the verify cell's projector, the same one `next` reads), stored as JSON with
 * null for fresh, so this file loads no other cell. Accept order is each item's newest accept event id, read from the board as the lander reads it.
 * With health.derivedState off (`enabled` not true) it writes no file at all.
 *
 * @param {any} board - An open file-backed board.
 * @param {{ mainCommit: string, enabled: boolean, listItems: (board: any) => any[], verdictState: (item: any) => any }} options - The main commit, the health.derivedState setting, the item reader and the verdict freshness reader.
 * @returns {{ file: string, freshness: number, acceptOrder: number } | null} Row counts written, or null when the setting is off or the board is not a file.
 */
export function sweepDerivedVerdicts(board, { mainCommit, enabled, listItems, verdictState }) {
  if (enabled !== true) return null;
  const boardFile = boardFileOf(board);
  if (!boardFile) return null;
  const accepted = listItems(board).filter(item => item.item_status === 'verified' && !item.item_merged_commit);
  const freshness = accepted.map(item => ({ key: String(item.item_id), value: JSON.stringify(verdictState(item) ?? null) }));
  const wanted = new Set(accepted.map(item => item.item_id));
  const order = board.db.prepare("SELECT item_id, MAX(event_id) AS event_id FROM event WHERE event_kind = 'accept' GROUP BY item_id ORDER BY MAX(event_id)").all()
    .filter(row => wanted.has(row.item_id)).map(row => ({ key: String(row.item_id), value: String(row.event_id) }));
  const fresh = writeRows(boardFile, mainCommit, 'verdict', freshness);
  writeRows(boardFile, mainCommit, 'accept-order', order);
  return { file: fresh.file, freshness: freshness.length, acceptOrder: order.length };
}
