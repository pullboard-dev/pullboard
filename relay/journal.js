/** Durable opaque upload ordering; record interpretation belongs to a later relay adapter [A4,H7]. */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Refused } from '../src/refused.js';

const FORMAT = 1;
const DEFAULT_BYTES = 100_000;

/** Validate a persistent identity before it can name an internal file. */
function identity(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Refused('BAD_BOARD', 'use the persistent board id, never a path');
  return value;
}

/**
 * Own a private per-board journal of uninterpreted bytes. It does not compute board state or
 * promise that a payload is encrypted. Its caller must authenticate and authorize every use.
 * This separate transport foundation does not replace the frozen #104 engine replay criterion.
 */
export function createRelayJournal({ directory, boardId, maxBytes = DEFAULT_BYTES, now = () => new Date() }) {
  const id = identity(boardId);
  if (typeof directory !== 'string' || !directory.trim() || typeof now !== 'function') throw new Refused('RELAY_CONFIG', 'configure a private journal directory and clock');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10_000_000) throw new Refused('RELAY_CONFIG', 'bound each opaque upload between one and ten million bytes');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const parent = lstatSync(root);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Refused('RELAY_STORAGE', 'use a private directory with mode 700 for relay journals');
  const file = join(root, id + '.journal.sqlite');
  try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Refused('RELAY_STORAGE', 'the journal must be a private regular database file');
  const db = new DatabaseSync(file);
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout = 30000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS journal_record (sequence INTEGER PRIMARY KEY, received_at TEXT NOT NULL, payload BLOB NOT NULL)');
    const saved = db.prepare('SELECT key, value FROM journal_meta ORDER BY key').all();
    if (saved.length === 0) {
      if (db.prepare('SELECT 1 FROM journal_record LIMIT 1').get()) throw new Refused('RELAY_STORAGE', 'restore the journal with its original identity and format metadata');
      db.prepare('INSERT INTO journal_meta (key,value) VALUES (?,?), (?,?)').run('board', id, 'format', String(FORMAT));
    } else if (saved.length !== 2 || saved[0].key !== 'board' || saved[0].value !== id || saved[1].key !== 'format' || saved[1].value !== String(FORMAT)) {
      throw new Refused('RELAY_STORAGE', 'open this journal with its original board identity and supported transport format');
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Initialization may have failed before its transaction. */ }
    db.close();
    throw error;
  }

  /** Keep calls after shutdown from exposing a native SQLite error. */
  function open() { if (closed) throw new Refused('RELAY_CLOSED', 'open the journal before reading or appending records'); }

  /** Convert an SQLite row to detached opaque bytes so callers cannot mutate a stored record. */
  function record(row) { return { sequence: row.sequence, receivedAt: row.received_at, bytes: Buffer.from(row.payload) }; }

  /** Read the latest committed sequence, including an empty journal's initial cursor. */
  function latest() {
    open();
    return db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM journal_record').get().sequence;
  }

  /** Serialize the prefix check and append so concurrent senders cannot both claim one sequence. */
  function append(sequence, bytes) {
    open();
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Refused('BAD_SEQUENCE', 'upload a positive safe integer sequence');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Refused('BAD_UPLOAD', 'send nonempty opaque bytes within the configured upload limit');
    const payload = Buffer.from(bytes);
    db.exec('BEGIN IMMEDIATE');
    try {
      const next = latest() + 1;
      if (sequence < next) throw new Refused('SEQUENCE_REPEAT', 'this sequence is already stored; resume after the latest committed sequence');
      if (sequence > next) throw new Refused('SEQUENCE_GAP', 'send the next sequence after the latest committed record before later uploads');
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Refused('RELAY_CONFIG', 'the journal clock must return a valid Date');
      db.prepare('INSERT INTO journal_record (sequence,received_at,payload) VALUES (?,?,?)').run(sequence, at.toISOString(), payload);
      const result = record(db.prepare('SELECT * FROM journal_record WHERE sequence=?').get(sequence));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Replay the committed prefix in order, without parsing or executing its payloads. */
  function after(sequence = 0) {
    open();
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Refused('BAD_CURSOR', 'resume after a nonnegative safe integer sequence');
    return db.prepare('SELECT * FROM journal_record WHERE sequence > ? ORDER BY sequence').all(sequence).map(record);
  }

  /** Close SQLite once, checkpointing the private journal before its owner removes any files. */
  function close() {
    if (closed) return;
    db.close();
    closed = true;
  }

  return { board: id, latest, append, after, close };
}
