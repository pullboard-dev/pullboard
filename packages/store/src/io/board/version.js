/** A cheap value that changes when a board connection's data may have, for per-revision read caches [H24]. */

/**
 * A value that changes whenever the board's data may have: another connection's commit moves SQLite's data_version,
 * and this connection's own writes move its total_changes.
 */
export function boardDataVersion(board) {
  return `${board.db.prepare('PRAGMA data_version').get().data_version}:${board.db.prepare('SELECT total_changes() AS n').get().n}`;
}
