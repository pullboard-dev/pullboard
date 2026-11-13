/**
 * Taking queued moves back (#1013): a local-first move is made on this machine before the relay orders it, and its
 * rows are captured as a SQLite changeset. When the relay's order arrives, the queued moves are taken back by their
 * inverted changesets, newest first, so the board is exactly as the relay last ordered it; replaying the relay's
 * records and making the queued moves again on top costs only the rows they touch, never a whole-board restore.
 */
import { suspendStoreGuards } from './board-store-guards.js';
import { atomic } from './board-event-log.js';

/** SQLite's changeset conflict type for a row whose values changed, and the answers to a conflict. */
const CHANGED = 1;
const REPLACE = 1;
const ABORT = 2;
/** What each other conflict type means, for the line that says why an undo fell back. */
const CONFLICTS = { 2: 'a row it changed is gone', 3: 'a row it removed is back', 4: 'a constraint refused it', 5: 'a foreign key refused it' };

/** SQLite's changeset operation codes. */
const INSERT = 18;
const UPDATE = 23;
const DELETE = 9;

/** Read one SQLite varint at `at`; returns its value and the next offset. */
function varint(bytes, at) {
  let value = 0;
  for (let index = 0; index < 8; index += 1) {
    const byte = bytes[at + index];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return { value, next: at + index + 1 };
  }
  return { value: value * 256 + bytes[at + 8], next: at + 9 };
}

/** Read one changeset value; returns its encoded bytes, whether it is defined, and the next offset. */
function value(bytes, at) {
  const type = bytes[at];
  if (type === 0 || type === 5) return { bytes: bytes.subarray(at, at + 1), defined: type !== 0, next: at + 1 };
  if (type === 1 || type === 2) return { bytes: bytes.subarray(at, at + 9), defined: true, next: at + 9 };
  if (type === 3 || type === 4) {
    const length = varint(bytes, at + 1);
    return { bytes: bytes.subarray(at, length.next + length.value), defined: true, next: length.next + length.value };
  }
  throw new Error(`changeset value type ${type} is not one SQLite writes`);
}

/** Read a record of `columns` values. */
function record(bytes, at, columns) {
  const values = [];
  let next = at;
  for (let column = 0; column < columns; column += 1) {
    const read = value(bytes, next);
    values.push(read);
    next = read.next;
  }
  return { values, next };
}

/** The encoded bytes of an undefined value. */
const UNDEFINED = Uint8Array.of(0);

/**
 * Invert a SQLite changeset, as sqlite3changeset_invert does: an insert becomes a delete of the same row, a delete an
 * insert, and an update swaps its changed values, so applying the result takes the original change back.
 *
 * @param {Uint8Array} changeset
 * @returns {Uint8Array}
 */
export function invertChangeset(changeset) {
  const bytes = Buffer.from(changeset);
  const out = [];
  let columns = 0;
  for (let at = 0; at < bytes.length;) {
    const marker = bytes[at];
    if (marker === 0x54) { // 'T': a table header, copied as it is.
      const count = varint(bytes, at + 1);
      columns = count.value;
      const end = bytes.indexOf(0, count.next + columns);
      if (!Number.isSafeInteger(columns) || columns < 1 || count.next + columns >= bytes.length || end < 0) {
        throw new Error('a changeset table header is incomplete');
      }
      out.push(bytes.subarray(at, end + 1));
      at = end + 1;
      continue;
    }
    const indirect = bytes[at + 1];
    if (marker === INSERT || marker === DELETE) {
      const row = record(bytes, at + 2, columns);
      out.push(Uint8Array.of(marker === INSERT ? DELETE : INSERT, indirect), bytes.subarray(at + 2, row.next));
      at = row.next;
    } else if (marker === UPDATE) {
      const before = record(bytes, at + 2, columns);
      const after = record(bytes, before.next, columns);
      out.push(Uint8Array.of(UPDATE, indirect));
      // The inverted update expects each changed column at its new value and keys the row as before.
      for (let column = 0; column < columns; column += 1) out.push(after.values[column].defined ? after.values[column].bytes : before.values[column].bytes);
      for (let column = 0; column < columns; column += 1) out.push(after.values[column].defined ? before.values[column].bytes : UNDEFINED);
      at = after.next;
    } else throw new Error(`changeset operation ${marker} is not one SQLite writes`);
  }
  return Buffer.concat(out);
}

/** Whether this connection accepts Node's newer callback form; the minimum Node requires a number. */
const CALLBACK_CONFLICTS = new WeakMap();

/** Probe an empty changeset, before any undo writes, without guessing the capability from a Node version. */
function callbackConflicts(db) {
  if (CALLBACK_CONFLICTS.has(db)) return CALLBACK_CONFLICTS.get(db);
  let supported = true;
  try { db.applyChangeset(new Uint8Array(), { onConflict: () => ABORT }); }
  catch (error) {
    if (error.code !== 'ERR_INVALID_ARG_TYPE' || !error.message.includes('options.onConflict') || !error.message.includes('number')) throw error;
    supported = false;
  }
  CALLBACK_CONFLICTS.set(db, supported);
  return supported;
}

/** Decode a primary-key value without losing SQLite's 64-bit integers or blob keys. */
function keyValue(encoded) {
  const bytes = encoded.bytes;
  if (bytes[0] === 1) return bytes.readBigInt64BE(1);
  if (bytes[0] === 2) return bytes.readDoubleBE(1);
  if (bytes[0] === 5) return null;
  if (bytes[0] === 3 || bytes[0] === 4) {
    const length = varint(bytes, 1);
    const content = bytes.subarray(length.next, length.next + length.value);
    return bytes[0] === 3 ? content.toString('utf8') : content;
  }
  throw new Error('a changeset primary key is undefined');
}

/** Quote a SQLite identifier read from the changeset or its actual table schema. */
function identifier(name) { return `"${name.replaceAll('"', '""')}"`; }

/**
 * Read the original inserted rows from a queued move's own changesets without applying them.
 * Local reconstruction needs the identities already returned to callers, not newly generated fact ids.
 * Schema checks use the same connection as reconstruction; malformed captures fail rather than guessing.
 */
export function capturedInserts(board, changes, wanted) {
  const rows = [];
  for (const change of changes ?? []) {
    const bytes = Buffer.from(change, 'base64');
    let columns = 0, table = null, schema = null;
    for (let at = 0; at < bytes.length;) {
      const marker = bytes[at];
      if (marker === 0x54) {
        const count = varint(bytes, at + 1);
        columns = count.value;
        const end = bytes.indexOf(0, count.next + columns);
        if (!Number.isSafeInteger(columns) || columns < 1 || end < 0) throw new Error('incomplete captured table');
        table = bytes.subarray(count.next + columns, end).toString('utf8');
        schema = table === wanted ? board.db.prepare(`PRAGMA table_info(${identifier(table)})`).all() : null;
        if (schema && (schema.length !== columns || schema.some((column, index) => Boolean(column.pk) !== Boolean(bytes[count.next + index])))) {
          throw new Error(`captured schema differs for ${table}`);
        }
        at = end + 1;
        continue;
      }
      if (!table || ![INSERT, UPDATE, DELETE].includes(marker)) throw new Error('invalid captured operation');
      const before = record(bytes, at + 2, columns);
      if (marker === INSERT && schema) rows.push(Object.fromEntries(schema.map((column, index) => {
        const decoded = keyValue(before.values[index]);
        return [column.name, typeof decoded === 'bigint' && decoded <= BigInt(Number.MAX_SAFE_INTEGER) && decoded >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(decoded) : decoded];
      })));
      at = marker === UPDATE ? record(bytes, before.next, columns).next : before.next;
      if (at > bytes.length) throw new Error('incomplete captured row');
    }
  }
  return rows;
}

/**
 * Numeric REPLACE also replaces a conflicting INSERT, which undo must refuse. Check row existence first,
 * inside the same write transaction, so only changed UPDATE/DELETE values can reach that resolution.
 * Check each changeset just before applying it: an earlier inverse may have restored or removed its keys.
 */
function legacyRowConflict(db, bytes) {
  let columns = 0;
  let keys = [];
  let lookup;
  for (let at = 0; at < bytes.length;) {
    const marker = bytes[at];
    if (marker === 0x54) {
      const count = varint(bytes, at + 1);
      columns = count.value;
      const flags = bytes.subarray(count.next, count.next + columns);
      const end = bytes.indexOf(0, count.next + columns);
      if (end < 0) throw new Error('a changeset table name is unterminated');
      const table = bytes.subarray(count.next + columns, end).toString('utf8');
      const schema = db.prepare(`PRAGMA table_info(${identifier(table)})`).all();
      if (schema.length !== columns || schema.some((column, index) => Boolean(column.pk) !== Boolean(flags[index]))) {
        throw new Error(`changeset primary keys do not match table ${table}`);
      }
      keys = schema.flatMap((column, index) => flags[index] ? [index] : []);
      if (!keys.length) throw new Error(`changeset table ${table} has no primary key`);
      lookup = db.prepare(`SELECT 1 FROM ${identifier(table)} WHERE ${keys.map(index => `${identifier(schema[index].name)} IS ?`).join(' AND ')}`);
      at = end + 1;
      continue;
    }
    if (![INSERT, UPDATE, DELETE].includes(marker) || !lookup) throw new Error(`invalid changeset operation ${marker}`);
    const row = record(bytes, at + 2, columns);
    const exists = Boolean(lookup.get(...keys.map(index => keyValue(row.values[index]))));
    if (marker === INSERT && exists) return CONFLICTS[3];
    if (marker !== INSERT && !exists) return CONFLICTS[2];
    at = marker === UPDATE ? record(bytes, row.next, columns).next : row.next;
  }
  return null;
}

/**
 * Take queued moves back on `board`, newest first, in one transaction, and put the row counters back as they were
 * before the oldest. Returns null, or, changing nothing, why it could not: a row they made is gone or a row they
 * removed is back, so the caller rebuilds from a whole image instead.
 * Why: the board's lifecycle triggers refuse removing events or moving an item backwards, as any command should;
 * taking back an unordered move is the one exception, so they are lifted inside this transaction only, as a
 * snapshot restore lifts them.
 *
 * @param {any} board
 * @param {{ changes?: string[], sequences?: { name: string, seq: number }[] }[]} entries - Oldest first.
 * @returns {string | null}
 */
export function undoQueued(board, entries) {
  const db = board.db;
  let conflict = null;
  const callbacks = callbackConflicts(db);
  try {
    atomic(board, () => {
      // A move's rows come back table by table; references between them are checked once all are back.
      db.exec('PRAGMA defer_foreign_keys = ON');
      const restoreGuards = suspendStoreGuards(board);
      // This connection lets an item's status change only under moveItem's token; taking a move back holds it too.
      db.exec('CREATE TEMP TABLE IF NOT EXISTS moving (token INTEGER); INSERT INTO temp.moving (token) VALUES (1)');
      for (const entry of [...entries].reverse()) {
        for (const change of [...(entry.changes ?? [])].reverse()) {
          // A row changed again since, as a seat's read position is, is put back all the same (its newer read
          // position is kept by the caller); a row gone or taken is not this undo's to guess at.
          const inverse = invertChangeset(Buffer.from(change, 'base64'));
          if (!callbacks) conflict = legacyRowConflict(db, inverse);
          let applied = false;
          if (!conflict) {
            try {
              applied = db.applyChangeset(inverse, { onConflict: callbacks
                ? (type) => { if (type === CHANGED) return REPLACE; conflict = CONFLICTS[type] ?? `conflict ${type}`; return ABORT; }
                : REPLACE });
            } catch (error) {
              // Older Node throws for an unsupported REPLACE resolution instead of exposing its conflict type.
              // The parsed changeset and its row keys are valid; refuse constraints and roll back the whole undo.
              if (callbacks || error.code !== 'ERR_SQLITE_ERROR') throw error;
              conflict = 'a constraint or foreign key refused it';
            }
          }
          if (conflict || applied === false) { conflict ??= 'aborted'; throw new Error(`a queued move's rows changed since it was made: ${conflict}`); }
        }
      }
      const counters = entries.find((entry) => Array.isArray(entry.sequences))?.sequences;
      if (counters) {
        db.exec('DELETE FROM sqlite_sequence');
        const insert = db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
        for (const row of counters) insert.run(row.name, row.seq);
      }
      db.exec('DELETE FROM temp.moving');
      restoreGuards();
    });
  } catch (error) {
    if (conflict) return conflict;
    throw error;
  }
  return null;
}
