/** Append-only board event kinds read once per connection, then only the events after them [C7]. */

const histories = new WeakMap();

/** Freeze a parsed value all the way down, so a caller cannot change what later callers read. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Whether this connection has an open transaction, so rows it reads could still roll back. */
function inTransaction(db) { return db.isTransaction !== false; }

/**
 * The parsed events of some kinds, oldest first. The first call on a connection reads them all; later calls read only
 * the events after the last one kept. Rows read inside a transaction are returned but not kept, so a rollback never
 * leaves a row behind; a kept prefix whose count or last id no longer matches the log refolds from the start.
 *
 * Why: on 5 Nov every gate-run write re-read and parsed all 6,644 gate runs (51 MB) four to six times inside the
 * board write lock, holding it 3-33 s on a loaded host and turning every other seat's write into BOARD_BUSY. Warmed
 * before BEGIN, the read inside the lock is only the few events since.
 *
 * @param {any} board an open board
 * @param {string} name the history's name; one name always uses one parse
 * @param {string[]} kinds the event kinds it holds
 * @param {(row: {event_id:number, event_by:string, item_id:number|null, event_at:string, event_kind:string, event_detail:string}) => any} parse
 *   turns one event into its kept value, or null to skip it
 * @returns {any[]} the kept values in event order; a fresh array, with frozen values
 */
export function eventHistory(board, name, kinds, parse) {
  const db = board.db;
  let byName = histories.get(db);
  if (!byName) histories.set(db, byName = new Map());
  const marks = kinds.map(() => '?').join(',');
  let kept = byName.get(name);
  if (kept) {
    const check = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(event_id), 0) AS last FROM event WHERE event_kind IN (${marks}) AND event_id <= ?`)
      .get(...kinds, kept.last);
    if (check.n !== kept.count || check.last !== kept.last) kept = undefined;
  }
  kept ??= { last: 0, count: 0, values: [] };
  const rows = db.prepare(`SELECT * FROM event
    WHERE event_kind IN (${marks}) AND event_id > ? ORDER BY event_id`).all(...kinds, kept.last);
  const fresh = [];
  for (const row of rows) {
    const value = parse(row);
    if (value !== null && value !== undefined) fresh.push(deepFreeze(value));
  }
  if (!inTransaction(db)) {
    if (rows.length) kept = { last: rows.at(-1).event_id, count: kept.count + rows.length, values: [...kept.values, ...fresh] };
    byName.set(name, kept);
    return kept.values.slice();
  }
  return [...kept.values, ...fresh];
}
