/** Weekly capacity rows kept on the board, one per ISO week, beside its other key-value records [C7,R1,R2]. */
import { readBoardMeta } from './meta.js';
import { writeBoardMeta } from './meta.js';

const PREFIX = 'capacity.week.';

/**
 * Record a week's capacity row, replacing the row that week already has; `runs` counts the readings it has absorbed.
 * Why replace: a second reading in the same week is a fresher measure of the same week, never a second row.
 *
 * @param {{ db: any }} board
 * @param {{ week: string }} row
 * @returns {{ week: string, runs: number }} The stored row.
 */
export function recordCapacityWeek(board, row) {
  const prior = readBoardMeta(board.db, PREFIX + row.week);
  const stored = { ...row, runs: (prior ? JSON.parse(prior).runs ?? 1 : 0) + 1 };
  writeBoardMeta(board.db, PREFIX + row.week, JSON.stringify(stored));
  return stored;
}

/**
 * Every recorded weekly capacity row, oldest week first.
 *
 * @param {{ db: any }} board
 * @returns {{ week: string, runs: number }[]}
 */
export function capacityWeeks(board) {
  return board.db.prepare("SELECT meta_value FROM board_meta WHERE substr(meta_key, 1, ?) = ? ORDER BY meta_key").all(PREFIX.length, PREFIX).map(row => JSON.parse(row.meta_value));
}
