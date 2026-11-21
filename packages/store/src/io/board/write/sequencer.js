/** The board sequencer commits only prepared writes: statements and params, never a callback [C7]. */
import { Refused } from "../../../../../kernel/index.js";
import { atomic } from '../event/log.js';

/** Refuse anything that is not a non-empty list of { sql, params } data before a transaction opens. */
function checkPrepared(statements) {
  if (!Array.isArray(statements) || statements.length === 0) throw new Refused('PREPARED_WRITE_REQUIRED', 'a board write is a non-empty array of { sql, params } statements, never a callback');
  statements.forEach((statement, index) => {
    if (typeof statement?.sql !== 'string' || statement.sql === '') throw new Refused('PREPARED_WRITE_REQUIRED', 'every prepared statement needs a sql string');
    if (statement.params !== undefined && !Array.isArray(statement.params)) throw new Refused('PREPARED_WRITE_REQUIRED', 'statement params must be an array');
    if (statement.expect !== undefined && !Number.isInteger(statement.expect)) throw new Refused('PREPARED_WRITE_REQUIRED', 'statement expect must be an integer change count');
    for (const param of statement.params ?? []) checkRefs(param, index);
  });
}

/** A ref names an earlier statement by index, so the list stays ordered data. */
function checkRef(n, index) {
  if (!Number.isInteger(n) || n < 0 || n >= index) throw new Refused('PREPARED_WRITE_REQUIRED', 'a param ref must name an earlier statement index');
}

/** Refuse a malformed { ref } or { json, refs } param; plain values pass untouched. */
function checkRefs(param, index) {
  if (param === null || typeof param !== 'object' || Array.isArray(param)) return;
  if ('ref' in param) return checkRef(param.ref, index);
  if ('json' in param) {
    for (const [path, n] of Object.entries(param.refs ?? {})) { if (path === '') throw new Refused('PREPARED_WRITE_REQUIRED', 'a json ref needs a path'); checkRef(n, index); }
  }
}

/** Bind a param: {ref:n} is statement n's inserted id; {json, refs} is the JSON text with ids set at dotted paths, key order kept. */
function bindParam(param, results) {
  if (param === null || typeof param !== 'object' || Array.isArray(param)) return param;
  if ('ref' in param) return results[param.ref].lastInsertRowid;
  if (!('json' in param)) return param;
  const copy = JSON.parse(JSON.stringify(param.json));
  for (const [path, n] of Object.entries(param.refs ?? {})) {
    const keys = path.split('.');
    const last = keys.pop();
    let node = copy;
    for (const key of keys) node = node?.[key];
    if (node === null || typeof node !== 'object') throw new Refused('PREPARED_WRITE_REQUIRED', `a json ref path ${path} does not exist`);
    node[last] = Number(results[n].lastInsertRowid);
  }
  return JSON.stringify(copy);
}

/**
 * Commit prepared statements in one immediate transaction recorded like every board write. No Git, file, network or
 * history scan can run inside it because the caller passes data, not work.
 *
 * @param {{ db: any, writeContext?: object }} board
 * @param {{ move?: string, statements: Array<{ sql: string, params?: unknown[], expect?: number }> }} write
 * @returns {Array<{ changes: number|bigint, lastInsertRowid: number|bigint }>} Each statement's result, in order.
 */
export function commitPrepared(board, { move, statements } = {}) {
  checkPrepared(statements);
  // The same envelope as logEvent: capture, write policy, review normalization and validation, then commit. A board with no lifecycle port has no review defaults to normalize.
  return atomic(board, () => {
    const results = [];
    statements.forEach(({ sql, params = [], expect }, index) => {
      const { changes, lastInsertRowid } = board.db.prepare(sql).run(...params.map(param => bindParam(param, results)));
      if (expect !== undefined && Number(changes) !== expect) throw new Refused('PREPARED_WRITE_UNEXPECTED_CHANGES', `statement ${index} changed ${changes} rows, expected ${expect}`);
      results.push({ changes, lastInsertRowid });
    });
    return results;
  }, { move, reviewPolicy: Boolean(board.runtimePorts?.lifecycle) });
}
