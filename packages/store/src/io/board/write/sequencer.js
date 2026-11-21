/** The board sequencer commits only prepared writes: statements and params, never a callback [C7]. */
import { Refused } from "../../../../../kernel/index.js";
import { recordedWriteLock } from '../busy.js';

/** Refuse anything that is not a non-empty list of { sql, params } data before a transaction opens. */
function checkPrepared(statements) {
  if (!Array.isArray(statements) || statements.length === 0) throw new Refused('PREPARED_WRITE_REQUIRED', 'a board write is a non-empty array of { sql, params } statements, never a callback');
  for (const statement of statements) {
    if (typeof statement?.sql !== 'string' || statement.sql === '') throw new Refused('PREPARED_WRITE_REQUIRED', 'every prepared statement needs a sql string');
    if (statement.params !== undefined && !Array.isArray(statement.params)) throw new Refused('PREPARED_WRITE_REQUIRED', 'statement params must be an array');
  }
}

/**
 * Commit prepared statements in one immediate transaction recorded like every board write. No Git, file, network or
 * history scan can run inside it because the caller passes data, not work.
 *
 * @param {{ db: any, writeContext?: object }} board
 * @param {{ move?: string, statements: Array<{ sql: string, params?: unknown[] }> }} write
 * @returns {Array<{ changes: number|bigint, lastInsertRowid: number|bigint }>} Each statement's result, in order.
 */
export function commitPrepared(board, { move, statements } = {}) {
  checkPrepared(statements);
  return recordedWriteLock(board, () => statements.map(({ sql, params = [] }) => {
    const { changes, lastInsertRowid } = board.db.prepare(sql).run(...params);
    return { changes, lastInsertRowid };
  }), move);
}
