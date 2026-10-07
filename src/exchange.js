/**
 * Export and import whole board files (A7), including their AUTOINCREMENT counters, so a copy can
 * continue producing the same ids after its rows are restored.
 */
import { Refused } from './refused.js';
import { storeTriggers } from './machine.js';

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
  const tables = Object.fromEntries(tableNames(board.db).map((table) => [
    table,
    board.db.prepare(`SELECT * FROM ${identifier(table)} ORDER BY ${table === 'sqlite_sequence' ? 'name' : 'rowid'}`).all(),
  ]));
  return { version: VERSION, tables };
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
    const occupied = names.filter((table) => db.prepare(`SELECT 1 FROM ${identifier(table)} LIMIT 1`).get());
    if (occupied.length) {
      throw new Refused('IMPORT_NOT_EMPTY', `board tables already have rows (${occupied.join(', ')}); import into a repo with an empty board`);
    }
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine_%'").all();
    for (const { name } of triggers) db.exec(`DROP TRIGGER ${identifier(name)}`);
    for (const table of names.filter((name) => name !== 'sqlite_sequence')) {
      const columns = columnsOf(db, table);
      const sql = `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      const insert = db.prepare(sql);
      for (const row of document.tables[table]) insert.run(...columns.map((column) => row[column]));
    }
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
