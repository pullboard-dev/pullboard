/**
 * Export and import whole board files (A7), including their AUTOINCREMENT counters, so a copy can
 * continue producing the same ids after its rows are restored.
 */
import { Refused } from './refused.js';
import { storeTriggers } from './machine.js';
import { EVENT_LOG_VERSION } from './board.js';

const VERSION = 1;

/**
 * Quote a SQLite identifier read from the database or a validated document.
 * @param {string} name
 * @returns {string}
 */
const identifier = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Names of the board's data tables, with sqlite_sequence last so imported counters remain exact.
 * @param {any} db
 * @returns {string[]}
 */
function tableNames(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get()) names.push('sqlite_sequence');
  return names;
}

/**
 * The columns in a board table, in their declared order.
 * @param {any} db
 * @param {string} table
 * @returns {string[]}
 */
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${identifier(table)})`).all().map(({ name }) => name);
}

/**
 * Capture every board table and row in the stable v1 document format.
 * @param {{ db: any }} board
 * @returns {{ version: number, tables: Record<string, any[]> }}
 */
export function exportBoard(board) {
  const db = board.db;
  db.exec('BEGIN DEFERRED');
  try {
    const tables = Object.fromEntries(tableNames(db).map((table) => [
      table,
      db.prepare(`SELECT * FROM ${identifier(table)} ORDER BY ${table === 'sqlite_sequence' ? 'name' : 'rowid'}`).all(),
    ]));
    db.exec('COMMIT');
    return { version: VERSION, tables };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Validate the document shape against the open board's schema before changing any rows.
 * @param {any} db
 * @param {any} document
 * @param {string[]} names
 */
function validateDocument(db, document, names) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== VERSION) {
    throw new Refused('IMPORT_VERSION', `expected board export version ${VERSION}; export it again with this pullboard version`);
  }
  if (!document.tables || typeof document.tables !== 'object' || Array.isArray(document.tables)) {
    throw new Refused('IMPORT_FORMAT', 'the export needs a tables object; use pullboard export to make one');
  }
  const supplied = Object.keys(document.tables).sort();
  const expected = [...names].sort();
  if (JSON.stringify(supplied) !== JSON.stringify(expected)) {
    throw new Refused('IMPORT_SCHEMA', `the export tables do not match this board; export and import with the same pullboard version`);
  }
  for (const table of names) {
    const columns = columnsOf(db, table);
    const rows = document.tables[table];
    if (!Array.isArray(rows)) throw new Refused('IMPORT_FORMAT', `table ${table} must contain an array of rows; export it again`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...columns].sort())) {
        throw new Refused('IMPORT_SCHEMA', `a ${table} row does not have exactly its board columns; export it again`);
      }
    }
  }
  const eventLog = document.tables.board_meta.find(({ meta_key }) => meta_key === 'event_log_version');
  const eventLogVersion = eventLog && /^(?:0|[1-9]\d*)$/u.test(eventLog.meta_value) ? Number(eventLog.meta_value) : eventLog ? NaN : 0;
  if (!Number.isSafeInteger(eventLogVersion) || eventLogVersion < 0) {
    throw new Refused('EVENT_LOG_VERSION', `event log version ${eventLog?.meta_value ?? 'missing'} in this export is invalid; export it again or upgrade pullboard`);
  }
  if (eventLogVersion > EVENT_LOG_VERSION) {
    throw new Refused('EVENT_LOG_VERSION', `event log version ${eventLogVersion} in this export is newer than this pullboard version ${EVENT_LOG_VERSION}; upgrade pullboard to read it`);
  }
}

/** Only the generated identity is disposable when restoring a fresh board (A2, A7). */
function hasOnlyIdentity(db) {
  const rows = db.prepare('SELECT * FROM board_meta').all();
  const identity = rows.find((row) => row.meta_key === 'board_id');
  const eventLog = rows.find((row) => row.meta_key === 'event_log_version');
  return /^[0-9a-f]{32}$/.test(identity?.meta_value ?? '')
    && rows.length === (eventLog ? 2 : 1)
    && rows.every((row) => row.meta_key === 'board_id' || row.meta_key === 'event_log_version');
}

/** True only for the coordinator registration and join event that `pullboard init` creates. */
function hasOnlyInitCoordinator(db, names) {
  if (!names.includes('sqlite_sequence') || !hasOnlyIdentity(db)) return false;
  const agents = db.prepare('SELECT * FROM agent').all();
  const events = db.prepare('SELECT * FROM event').all();
  const sequence = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();
  if (agents.length !== 1 || events.length !== 1 || sequence.length !== 1) return false;
  const [agent] = agents;
  const [event] = events;
  if (
    agent.agent_id !== 'coordinator'
    || agent.agent_lane !== 'coordinator'
    || agent.agent_route !== 'strong'
    || agent.agent_last_shout_id !== 0
    || !agent.agent_path
    || event.event_by !== 'coordinator'
    || event.event_kind !== 'join'
    || event.item_id !== null
    || sequence[0].name !== 'event'
    || sequence[0].seq !== 1
  ) return false;
  try {
    if (JSON.stringify(JSON.parse(event.event_detail)) !== JSON.stringify({ lane: 'coordinator' })) return false;
  } catch {
    return false;
  }
  return names
    .filter((table) => table !== 'agent' && table !== 'event' && table !== 'sqlite_sequence' && table !== 'board_meta')
    .every((table) => !db.prepare(`SELECT 1 FROM ${identifier(table)} LIMIT 1`).get());
}

/**
 * Restore a v1 export only into an empty board, atomically, while briefly allowing historical item
 * states to be inserted before restoring the board's declared lifecycle triggers.
 * @param {{ db: any }} board
 * @param {any} document
 * @returns {{ tables: string[] }}
 */
export function importBoard(board, document) {
  const db = board.db;
  const names = tableNames(db);
  validateDocument(db, document, names);
  db.exec('PRAGMA defer_foreign_keys = ON; BEGIN IMMEDIATE');
  try {
    const onlyIdentity = hasOnlyIdentity(db);
    const occupied = names.filter((table) => !(table === 'board_meta' && onlyIdentity) && db.prepare(`SELECT 1 FROM ${identifier(table)} LIMIT 1`).get());
    const initCoordinator = occupied.length > 0 && hasOnlyInitCoordinator(db, names);
    if (occupied.length && !initCoordinator) {
      throw new Refused('IMPORT_NOT_EMPTY', `board tables already have rows (${occupied.join(', ')}); import into a repo with an empty board`);
    }
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine_%'").all();
    for (const { name } of triggers) db.exec(`DROP TRIGGER ${identifier(name)}`);
    if (initCoordinator) {
      db.exec('DELETE FROM event; DELETE FROM agent; DELETE FROM sqlite_sequence');
    }
    if (onlyIdentity) db.exec('DELETE FROM board_meta');
    for (const table of names.filter((name) => name !== 'sqlite_sequence')) {
      const columns = columnsOf(db, table);
      const sql = `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      const insert = db.prepare(sql);
      for (const row of document.tables[table]) insert.run(...columns.map((column) => row[column]));
    }
    db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
      .run('event_log_version', String(EVENT_LOG_VERSION));
    const setSequence = db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?');
    for (const row of document.tables.sqlite_sequence ?? []) {
      if (!setSequence.run(row.seq, row.name).changes) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(row.name, row.seq);
    }
    for (const { name, sql } of storeTriggers()) db.exec(sql);
    db.exec('COMMIT');
    return { tables: names };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
