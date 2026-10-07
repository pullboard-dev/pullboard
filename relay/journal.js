/** Durable opaque upload ordering; record interpretation belongs to a later relay adapter [A4,H7]. */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Refused } from '../src/refused.js';

const FORMAT = 2;
const DEFAULT_BYTES = 100_000;

/** Validate a persistent identity before it can name an internal file. */
function identity(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/.test(value)) throw new Refused('BAD_BOARD', 'use the persistent board id, never a path');
  return value;
}

/**
 * Own a private per-board journal of uninterpreted bytes. It does not compute board state or
 * promise that a payload is encrypted. Its caller must authenticate and authorize every use.
 * Sender metadata is public authentication context, not an interpretation of a sealed payload.
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
    db.exec('PRAGMA busy_timeout = 30000; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; BEGIN IMMEDIATE');
    db.exec(`CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_record (sequence INTEGER PRIMARY KEY, received_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('move','request')), payload BLOB NOT NULL,
        sender_kind TEXT NOT NULL CHECK(sender_kind IN ('person','agent')), sender_user TEXT NOT NULL,
        sender_agent TEXT, CHECK((sender_kind='person' AND sender_agent IS NULL) OR
          (sender_kind='agent' AND sender_agent IS NOT NULL)))`);
    const saved = db.prepare('SELECT key, value FROM journal_meta ORDER BY key').all();
    if (saved.length === 0) {
      if (db.prepare('SELECT 1 FROM journal_record LIMIT 1').get()) throw new Refused('RELAY_STORAGE', 'restore the journal with its original identity and format metadata');
      db.prepare('INSERT INTO journal_meta (key,value) VALUES (?,?), (?,?)').run('board', id, 'format', String(FORMAT));
    } else if (saved.length !== 2 || saved[0].key !== 'board' || saved[0].value !== id || saved[1].key !== 'format' || saved[1].value !== String(FORMAT)) {
      throw new Refused('RELAY_STORAGE', 'open this journal with its original board identity and supported transport format');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS journal_head (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_snapshot (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL,
        received_at TEXT NOT NULL, payload BLOB NOT NULL, sender_kind TEXT NOT NULL CHECK(sender_kind='person'),
        sender_user TEXT NOT NULL, sender_agent TEXT CHECK(sender_agent IS NULL))`);
    db.exec('INSERT OR IGNORE INTO journal_head (slot,sequence) SELECT 1, COALESCE(MAX(sequence),0) FROM journal_record');
    if (!db.prepare('PRAGMA table_info(journal_head)').all().some((column) => column.name === 'last_activity_at')) {
      db.exec('ALTER TABLE journal_head ADD COLUMN last_activity_at TEXT');
      db.exec('UPDATE journal_head SET last_activity_at=(SELECT MAX(received_at) FROM journal_record)');
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
  function record(row) {
    return { sequence: row.sequence, receivedAt: row.received_at, kind: row.kind ?? 'snapshot',
      sender: { kind: row.sender_kind, userId: row.sender_user,
        ...(row.sender_kind === 'agent' ? { agent: row.sender_agent } : {}) }, bytes: Buffer.from(row.payload) };
  }

  /** Require server-derived attribution, copying only its public identity and never a credential. */
  function sender(value, personOnly = false) {
    if (!value || !['person', 'agent'].includes(value.kind) || typeof value.userId !== 'string' ||
        !value.userId.length || value.userId.length > 256 ||
        (value.kind === 'agent' && (typeof value.agent !== 'string' || !value.agent.length || value.agent.length > 256))) {
      throw new Refused('RELAY_PRINCIPAL', 'supply the authenticated sender before storing a sealed record');
    }
    if (personOnly && value.kind !== 'person') throw new Refused('HUMAN_REQUIRED', 'sign in as a person to replace a board snapshot');
    return { kind: value.kind, userId: value.userId, agent: value.kind === 'agent' ? value.agent : null };
  }

  /** Read the latest committed sequence, including an empty journal's initial cursor. */
  function latest() {
    open();
    return db.prepare('SELECT sequence FROM journal_head WHERE slot=1').get().sequence;
  }

  /** Last sealed move/request receipt survives snapshot compaction and a service restart. */
  function activity() {
    open();
    return db.prepare('SELECT last_activity_at FROM journal_head WHERE slot=1').get().last_activity_at;
  }

  /** Require detached bounded opaque bytes before opening a write transaction. */
  function payload(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Refused('BAD_UPLOAD', 'send nonempty opaque bytes within the configured upload limit');
    return Buffer.from(bytes);
  }

  /** Serialize prefix checking or sequence allocation with the opaque append. */
  function insert(sequence, bytes, kind, principal) {
    open();
    if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new Refused('BAD_SEQUENCE', 'upload a positive safe integer sequence');
    const sealed = payload(bytes);
    const who = sender(principal);
    if (!['move', 'request'].includes(kind)) throw new Refused('BAD_UPLOAD', 'use the move or request transport kind');
    db.exec('BEGIN IMMEDIATE');
    try {
      const next = latest() + 1;
      if (!Number.isSafeInteger(next)) throw new Refused('SEQUENCE_LIMIT', 'link a new board before the journal exhausts safe sequence numbers');
      if (sequence === null) sequence = next;
      if (sequence < next) throw new Refused('SEQUENCE_REPEAT', 'this sequence is already stored; resume after the latest committed sequence');
      if (sequence > next) throw new Refused('SEQUENCE_GAP', 'send the next sequence after the latest committed record before later uploads');
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Refused('RELAY_CONFIG', 'the journal clock must return a valid Date');
      db.prepare('INSERT INTO journal_record (sequence,received_at,kind,payload,sender_kind,sender_user,sender_agent) VALUES (?,?,?,?,?,?,?)').run(sequence, at.toISOString(), kind, sealed, who.kind, who.userId, who.agent);
      db.prepare('UPDATE journal_head SET sequence=?,last_activity_at=? WHERE slot=1').run(sequence, at.toISOString());
      const result = record(db.prepare('SELECT * FROM journal_record WHERE sequence=?').get(sequence));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Append a transport retry only at its explicitly named next sequence. */
  function append(sequence, bytes, kind = 'move', principal) { return insert(sequence, bytes, kind, principal); }

  /** Allocate the next sequence under the same lock as the append, as the live relay requires. */
  function appendNext(bytes, kind = 'move', principal) { return insert(null, bytes, kind, principal); }

  /** Read the latest sealed snapshot without interpreting its contents. */
  function snapshot() {
    open();
    const row = db.prepare('SELECT * FROM journal_snapshot WHERE slot=1').get();
    return row ? record(row) : null;
  }

  /** Replace a covered snapshot and compact only its acknowledged prefix, keeping the head. */
  function saveSnapshot(sequence, bytes, principal) {
    open();
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Refused('BAD_SEQUENCE', 'name the nonnegative sequence this snapshot covers');
    const sealed = payload(bytes);
    const who = sender(principal, true);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (sequence > latest()) throw new Refused('SEQUENCE_GAP', 'upload the missing moves before a snapshot that covers them');
      const previous = snapshot();
      if (previous && sequence < previous.sequence) throw new Refused('SNAPSHOT_STALE', 'use the latest stored snapshot and seal a snapshot that covers at least its sequence');
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Refused('RELAY_CONFIG', 'the journal clock must return a valid Date');
      db.prepare('INSERT INTO journal_snapshot (slot,sequence,received_at,payload,sender_kind,sender_user,sender_agent) VALUES (1,?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET sequence=excluded.sequence,received_at=excluded.received_at,payload=excluded.payload,sender_kind=excluded.sender_kind,sender_user=excluded.sender_user,sender_agent=excluded.sender_agent').run(sequence, at.toISOString(), sealed, who.kind, who.userId, who.agent);
      db.prepare('DELETE FROM journal_record WHERE sequence <= ?').run(sequence);
      const result = snapshot();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
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

  return { board: id, latest, activity, append, appendNext, after, snapshot, saveSnapshot, close };
}
