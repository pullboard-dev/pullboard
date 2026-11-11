/** Optimistic preparation is bound to one connection's actual SQLite contents [B2,C7]. */
import { Refused } from "../../../../../kernel/index.js";

/**
 * Capture other connections' commits and this connection's own intervening writes without a lock.
 * @param {any} board
 * @returns {{version:number, changes:number}}
 */
export function boardWriteSnapshot(board) {
  return { version: board.db.prepare('PRAGMA data_version').get().data_version,
    changes: board.db.prepare('SELECT total_changes() AS n').get().n };
}

/**
 * A changed snapshot must be prepared again; neither source work nor stale state runs under BEGIN.
 * @param {any} board
 * @param {{version:number, changes:number}} snapshot
 * @param {string} operation
 */
export function requireBoardWriteSnapshot(board, snapshot, operation) {
  const current = boardWriteSnapshot(board);
  if (current.version !== snapshot.version || current.changes !== snapshot.changes) {
    throw new Refused('BOARD_BUSY', `the board changed while preparing ${operation}; retry from the current board snapshot`);
  }
}
