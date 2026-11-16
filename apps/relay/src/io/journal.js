/** Durable opaque upload ordering; record interpretation belongs to a later relay adapter [A4,H7]. */
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { Refused } from '../../../../packages/kernel/index.js';
import { SEALED_SNAPSHOT_BYTES } from '../../../../packages/link/index.js';
import { createRelayPages } from './store/page.js';

const FORMAT = 4;
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
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SEALED_SNAPSHOT_BYTES) throw new Refused('RELAY_CONFIG', 'bound each opaque upload to the shared snapshot limit');
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
  let writing = false;
  try {
    db.exec('PRAGMA busy_timeout = 30000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete = ON; BEGIN IMMEDIATE');
    db.exec(`CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_record (sequence INTEGER PRIMARY KEY, received_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('move','request')), payload BLOB NOT NULL,
        sender_kind TEXT NOT NULL CHECK(sender_kind IN ('person','agent','machine')), sender_user TEXT NOT NULL,
        sender_agent TEXT, CHECK((sender_kind='person' AND sender_agent IS NULL) OR
          (sender_kind IN ('agent','machine') AND sender_agent IS NOT NULL)))`);
    const saved = db.prepare('SELECT key, value FROM journal_meta ORDER BY key').all();
    if (saved.length === 0) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='page_meta'").get()) {
        const owner = db.prepare("SELECT value FROM page_meta WHERE key='board'").get();
        if (owner && owner.value !== id) throw new Refused('RELAY_STORAGE', 'Restore sealed pages with their original journal board identity.');
      }
      if (db.prepare('SELECT 1 FROM journal_record LIMIT 1').get()) throw new Refused('RELAY_STORAGE', 'restore the journal with its original identity and format metadata');
      db.prepare('INSERT INTO journal_meta (key,value) VALUES (?,?), (?,?)').run('board', id, 'format', String(FORMAT));
    } else if (saved.length !== 2 || saved[0].key !== 'board' || saved[0].value !== id || saved[1].key !== 'format' || !['2', '3', String(FORMAT)].includes(saved[1].value)) {
      throw new Refused('RELAY_STORAGE', 'open this journal with its original board identity and supported transport format');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS journal_upload_status (slot INTEGER PRIMARY KEY CHECK(slot=1), payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_head (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_snapshot (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL,
        received_at TEXT NOT NULL, payload BLOB NOT NULL, sender_kind TEXT NOT NULL CHECK(sender_kind IN ('person','machine')),
        sender_user TEXT NOT NULL, sender_agent TEXT, CHECK((sender_kind='person' AND sender_agent IS NULL) OR
          (sender_kind='machine' AND sender_agent IS NOT NULL)))`);
    // The authenticated machine principal needs new CHECK constraints; preserve every opaque byte.
    if (saved[1]?.value === '2') {
      db.exec(`ALTER TABLE journal_record RENAME TO journal_record_v2;
        CREATE TABLE journal_record (sequence INTEGER PRIMARY KEY, received_at TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('move','request')), payload BLOB NOT NULL,
          sender_kind TEXT NOT NULL CHECK(sender_kind IN ('person','agent','machine')), sender_user TEXT NOT NULL,
          sender_agent TEXT, CHECK((sender_kind='person' AND sender_agent IS NULL) OR
            (sender_kind IN ('agent','machine') AND sender_agent IS NOT NULL)));
        INSERT INTO journal_record SELECT * FROM journal_record_v2;
        DROP TABLE journal_record_v2;
        ALTER TABLE journal_snapshot RENAME TO journal_snapshot_v2;
        CREATE TABLE journal_snapshot (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL,
          received_at TEXT NOT NULL, payload BLOB NOT NULL, sender_kind TEXT NOT NULL CHECK(sender_kind IN ('person','machine')),
          sender_user TEXT NOT NULL, sender_agent TEXT, CHECK((sender_kind='person' AND sender_agent IS NULL) OR
            (sender_kind='machine' AND sender_agent IS NOT NULL)));
        INSERT INTO journal_snapshot SELECT * FROM journal_snapshot_v2;
        DROP TABLE journal_snapshot_v2;
        UPDATE journal_meta SET value='3' WHERE key='format';`);
    }
    for (const [column, type] of [['api_version', 'INTEGER NOT NULL DEFAULT 1'], ['page_bytes', 'INTEGER'], ['epoch', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!db.prepare('PRAGMA table_info(journal_snapshot)').all().some(row => row.name === column)) db.exec(`ALTER TABLE journal_snapshot ADD COLUMN ${column} ${type}`);
    }
    db.prepare('UPDATE journal_meta SET value=? WHERE key=?').run(String(FORMAT), 'format');
    // Engine-27 attribution (#579): the relay's policy stamp, the person-set coordinator flag and a
    // seat receipt. Older records keep these empty, so they replay exactly as they did.
    // Engine-73 people (#343): the GitHub login behind each record, and whether that person was one of the
    // board's approvers when it arrived. Older records keep them empty and replay as they did.
    for (const [column, type] of [['sender_policy', 'INTEGER'], ['sender_root', 'INTEGER'], ['sender_lineage', 'TEXT'], ['registration', 'TEXT'],
      ['sender_login', 'TEXT'], ['sender_approver', 'INTEGER'], ['sender_engine', 'INTEGER'], ['sender_presence', 'TEXT']]) {
      if (!db.prepare('PRAGMA table_info(journal_record)').all().some((saved) => saved.name === column)) db.exec(`ALTER TABLE journal_record ADD COLUMN ${column} ${type}`);
    }
    // A published seat receipt claims its target for good: compaction keeps it, so no later machine
    // first mint can take a name a creator registered, even if enrollment never finished (#579).
    db.exec(`CREATE TABLE IF NOT EXISTS journal_registration (target TEXT PRIMARY KEY, creator TEXT NOT NULL,
      sequence INTEGER NOT NULL UNIQUE, digest TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS board_link_delivery (
      delivery_id INTEGER PRIMARY KEY AUTOINCREMENT, source_board TEXT NOT NULL,
      correlation TEXT NOT NULL, link_id TEXT NOT NULL, generation INTEGER NOT NULL,
      position INTEGER NOT NULL, digest TEXT NOT NULL, envelope TEXT NOT NULL, receipt TEXT NOT NULL,
      UNIQUE(source_board,correlation))`);
    db.exec('CREATE INDEX IF NOT EXISTS board_link_delivery_position ON board_link_delivery(source_board,link_id,generation,position DESC)');
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

  /** Share one SQLite transaction between a sealed-object publication and its journal coverage cursor. */
  function transaction(work) {
    open();
    if (writing) return work();
    db.exec('BEGIN IMMEDIATE'); writing = true;
    try {
      const result = work();
      if (result && typeof result.then === 'function') throw new Refused('RELAY_CONFIG', 'Finish the journal transaction before awaiting.');
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { writing = false; }
  }

  /** Store page objects beside the head so existing consistent backups and unlink cleanup cover both. */
  function pages(options = {}) {
    open();
    return createRelayPages({ directory: root, boardId: id, now: options.now ?? Date.now, database: db, transaction });
  }

  /** Convert an SQLite row to detached opaque bytes so callers cannot mutate a stored record. */
  function record(row) {
    return { sequence: row.sequence, receivedAt: row.received_at, kind: row.kind ?? 'snapshot',
      sender: { kind: row.sender_kind, userId: row.sender_user,
        ...(row.sender_kind === 'agent' ? { agent: row.sender_agent } : row.sender_kind === 'machine' ? { machine: row.sender_agent } : {}),
        ...(row.sender_policy ? { policy: row.sender_policy } : {}), ...(row.sender_root ? { root: true } : {}),
        ...(row.sender_lineage ? { lineage: row.sender_lineage } : {}),
        ...(row.sender_login ? { login: row.sender_login } : {}), ...(row.sender_approver === null || row.sender_approver === undefined ? {} : { approver: row.sender_approver === 1 }),
        ...(row.sender_engine ? { engine: row.sender_engine } : {}), ...(row.sender_presence ? { presence: JSON.parse(row.sender_presence) } : {}) },
      ...(row.registration ? { registration: JSON.parse(row.registration) } : {}),
      ...(row.api_version === 2 ? { apiVersion: 2, pageBytes: row.page_bytes } : {}), ...(row.epoch ? { epoch: row.epoch } : {}), bytes: Buffer.from(row.payload) };
  }

  /** Require server-derived attribution, copying only its public identity and never a credential. */
  function sender(value, personOnly = false) {
    if (!value || !['person', 'agent', 'machine'].includes(value.kind) || typeof value.userId !== 'string' ||
        !value.userId.length || value.userId.length > 256 ||
        (value.kind === 'agent' && (typeof value.agent !== 'string' || !value.agent.length || value.agent.length > 256)) ||
        (value.kind === 'machine' && (typeof value.machine !== 'string' || !value.machine.length || value.machine.length > 256))) {
      throw new Refused('RELAY_PRINCIPAL', 'supply the authenticated sender before storing a sealed record');
    }
    if (personOnly && !['person', 'machine'].includes(value.kind)) throw new Refused('HUMAN_REQUIRED', 'use this board’s machine credential to replace its snapshot');
    if ((value.policy !== undefined && (!Number.isSafeInteger(value.policy) || value.policy < 1)) || (value.root !== undefined && value.root !== true) ||
        (value.lineage !== undefined && (typeof value.lineage !== 'string' || !/^[0-9a-f-]{36}$/.test(value.lineage))) ||
        (value.login !== undefined && (typeof value.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/u.test(value.login))) ||
        (value.approver !== undefined && typeof value.approver !== 'boolean') || (value.engine !== undefined && (!Number.isSafeInteger(value.engine) || value.engine < 1)) ||
        (value.presence !== undefined && (value.kind !== 'person' || !value.presence || typeof value.presence !== 'object'))) {
      throw new Refused('RELAY_PRINCIPAL', 'supply the relay policy stamp as a positive engine number');
    }
    return { kind: value.kind, userId: value.userId, agent: value.kind === 'agent' ? value.agent : value.kind === 'machine' ? value.machine : null,
      policy: value.policy ?? null, root: value.root === true ? 1 : null, lineage: value.lineage ?? null,
      login: value.login ?? null, approver: value.approver === undefined ? null : value.approver ? 1 : 0, engine: value.engine ?? null,
      presence: value.presence === undefined ? null : JSON.stringify(value.presence) };
  }

  /** Keep a seat receipt to its four public fields: target, creator, sequence and ciphertext digest. */
  function receipt(value, sequence) {
    if (value === undefined || value === null) return null;
    const fields = ['creator', 'digest', 'sequence', 'target'];
    if (typeof value !== 'object' || Object.keys(value).sort().join() !== fields.join() || value.sequence !== sequence ||
        typeof value.target !== 'string' || typeof value.creator !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest ?? '')) {
      throw new Refused('BAD_REGISTRATION', 'attach a seat receipt naming its target, creator, this sequence and the ciphertext digest');
    }
    return JSON.stringify({ target: value.target, creator: value.creator, sequence: value.sequence, digest: value.digest });
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
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Refused('BAD_UPLOAD', 'send nonempty opaque bytes within the configured upload limit');
    if (bytes.byteLength > maxBytes) {
      const error = new Refused('BAD_UPLOAD', 'send nonempty opaque bytes within the configured upload limit');
      error.snapshotLimit = { sealedBytes: bytes.byteLength, limit: maxBytes };
      throw error;
    }
    return Buffer.from(bytes);
  }

  /** Serialize prefix checking or sequence allocation with the opaque append. */
  function insert(sequence, bytes, kind, principal, registration) {
    open();
    if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new Refused('BAD_SEQUENCE', 'upload a positive safe integer sequence');
    const sealed = payload(bytes);
    const who = sender(principal);
    if (!['move', 'request'].includes(kind)) throw new Refused('BAD_UPLOAD', 'use the move or request transport kind');
    if (registration !== undefined && (sequence === null || kind !== 'move')) throw new Refused('BAD_REGISTRATION', 'attach a seat receipt only to a move at its named sequence');
    const stored = receipt(registration, sequence);
    db.exec('BEGIN IMMEDIATE');
    try {
      const next = latest() + 1;
      if (!Number.isSafeInteger(next)) throw new Refused('SEQUENCE_LIMIT', 'link a new board before the journal exhausts safe sequence numbers');
      if (sequence === null) sequence = next;
      if (sequence < next) throw new Refused('SEQUENCE_REPEAT', 'this sequence is already stored; resume after the latest committed sequence');
      if (sequence > next) throw new Refused('SEQUENCE_GAP', 'send the next sequence after the latest committed record before later uploads');
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Refused('RELAY_CONFIG', 'the journal clock must return a valid Date');
      db.prepare('INSERT INTO journal_record (sequence,received_at,kind,payload,sender_kind,sender_user,sender_agent,sender_policy,sender_root,sender_lineage,registration,sender_login,sender_approver,sender_engine,sender_presence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(sequence, at.toISOString(), kind, sealed, who.kind, who.userId, who.agent, who.policy, who.root, who.lineage, stored, who.login, who.approver, who.engine, who.presence);
      if (stored) {
        const claim = JSON.parse(stored);
        if (db.prepare('SELECT 1 FROM journal_registration WHERE target=?').get(claim.target)) {
          throw new Refused('SEAT_TAKEN', `${claim.target} was already registered; register the next free name`);
        }
        db.prepare('INSERT INTO journal_registration (target,creator,sequence,digest) VALUES (?,?,?,?)').run(claim.target, claim.creator, claim.sequence, claim.digest);
      }
      db.prepare('UPDATE journal_head SET sequence=?,last_activity_at=? WHERE slot=1').run(sequence, at.toISOString());
      const result = record(db.prepare('SELECT * FROM journal_record WHERE sequence=?').get(sequence));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Append a transport retry only at its explicitly named next sequence, with an optional seat receipt. */
  function append(sequence, bytes, kind = 'move', principal, registration) { return insert(sequence, bytes, kind, principal, registration); }

  /** The committed seat receipt that claims this target, kept through compaction, or null. */
  function registrationFor(target) {
    open();
    const row = db.prepare('SELECT target,creator,sequence,digest FROM journal_registration WHERE target=?').get(target);
    return row ? { target: row.target, creator: row.creator, sequence: row.sequence, digest: row.digest } : null;
  }

  /** Read one committed record, or null once compaction removed it, for an exact registration retry. */
  function recordAt(sequence) {
    open();
    const row = db.prepare('SELECT * FROM journal_record WHERE sequence=?').get(sequence);
    return row ? record(row) : null;
  }

  /** Allocate the next sequence under the same lock as the append, as the live relay requires. */
  function appendNext(bytes, kind = 'move', principal) { return insert(null, bytes, kind, principal); }

  /** Read the latest sealed snapshot without interpreting its contents. */
  function snapshot() {
    open();
    const row = db.prepare('SELECT * FROM journal_snapshot WHERE slot=1').get();
    return row ? record(row) : null;
  }

  /** Retain only a small opaque publisher notice, never a readable size or repository name. */
  function saveUploadStatus(bytes) {
    open();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 29 || bytes.byteLength > 16_384) {
      throw new Refused('BAD_UPLOAD', 'Send one bounded sealed upload notice.');
    }
    return transaction(() => {
      if (snapshot()) return false;
      db.prepare('INSERT INTO journal_upload_status VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET payload=excluded.payload').run(bytes);
      return true;
    });
  }

  /** Read an opaque notice without treating it as an uploaded board snapshot. */
  function uploadStatus() {
    open();
    return db.prepare('SELECT payload FROM journal_upload_status WHERE slot=1').get()?.payload ?? null;
  }

  /**
   * Replace a covered snapshot and compact only its acknowledged prefix, keeping the head. A `recovery` checkpoint
   * replaces what the log says at the same sequence, so it raises the snapshot's epoch: a computer that read the log
   * up to that sequence cannot see the change any other way (#7776).
   */
  function saveSnapshot(sequence, bytes, principal, { initialOnly = false, apiVersion = 1, pageBytes = null, recovery = false } = {}) {
    open();
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Refused('BAD_SEQUENCE', 'name the nonnegative sequence this snapshot covers');
    if (![1, 2].includes(apiVersion) || apiVersion === 2 && (!Number.isSafeInteger(pageBytes) || pageBytes < 1)) throw new Refused('SNAPSHOT_VERSION', 'Publish a supported snapshot transport version and its sealed root length.');
    const sealed = payload(bytes);
    const who = sender(principal, true);
    return transaction(() => {
      if (sequence > latest()) throw new Refused('SEQUENCE_GAP', 'upload the missing moves before a snapshot that covers them');
      const previous = snapshot();
      if (initialOnly && previous) throw new Refused('BASELINE_EXISTS', 'this board already has a baseline; preserve the local board before choosing which history to keep');
      if (previous && sequence < previous.sequence) throw new Refused('SNAPSHOT_STALE', 'use the latest stored snapshot and seal a snapshot that covers at least its sequence');
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Refused('RELAY_CONFIG', 'the journal clock must return a valid Date');
      db.prepare('INSERT INTO journal_snapshot (slot,sequence,received_at,payload,sender_kind,sender_user,sender_agent,api_version,page_bytes,epoch) VALUES (1,?,?,?,?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET sequence=excluded.sequence,received_at=excluded.received_at,payload=excluded.payload,sender_kind=excluded.sender_kind,sender_user=excluded.sender_user,sender_agent=excluded.sender_agent,api_version=excluded.api_version,page_bytes=excluded.page_bytes,epoch=excluded.epoch').run(sequence, at.toISOString(), sealed, who.kind, who.userId, who.agent, apiVersion, apiVersion === 2 ? pageBytes : null, (previous?.epoch ?? 0) + (recovery ? 1 : 0));
      db.prepare('DELETE FROM journal_record WHERE sequence <= ?').run(sequence);
      db.prepare('DELETE FROM journal_upload_status').run();
      const result = snapshot();
      return result;
    });
  }

  /** Measure the exact retained-byte change of a replacement and its compacted acknowledged prefix. */
  function snapshotDelta(sequence, bytes) {
    open();
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Refused('BAD_SEQUENCE', 'Name the snapshot coverage sequence before accounting for storage.');
    const size = payload(bytes).byteLength;
    const previous = db.prepare('SELECT COALESCE(SUM(length(payload)),0) AS bytes FROM journal_snapshot').get().bytes;
    const compacted = db.prepare('SELECT COALESCE(SUM(length(payload)),0) AS bytes FROM journal_record WHERE sequence<=?').get(sequence).bytes;
    return size - previous - compacted;
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

  return { board: id, latest, activity, append, appendNext, recordAt, registrationFor, after, snapshot, saveSnapshot, snapshotDelta,
    saveUploadStatus, uploadStatus, pages, close };
}
