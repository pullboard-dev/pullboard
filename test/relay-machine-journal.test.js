/** Migrate the opaque journal without changing legacy attribution or bytes [H7,H15]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRelayJournal } from '../relay/journal.js';

const ID = 'd'.repeat(32);
const PERSON = { kind: 'person', userId: '101' };
const MACHINE = { kind: 'machine', userId: '101', machine: 'machine-phone' };

/** Create the original format-2 SQLite tables and seed opaque records without using production writers. */
function createLegacyJournal(directory, format = '2') {
  const path = join(directory, ID + '.journal.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    db.exec(`CREATE TABLE journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE journal_record (sequence INTEGER PRIMARY KEY, received_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('move','request')), payload BLOB NOT NULL,
        sender_kind TEXT NOT NULL CHECK(sender_kind IN ('person','agent')), sender_user TEXT NOT NULL,
        sender_agent TEXT, CHECK((sender_kind='person' AND sender_agent IS NULL) OR
          (sender_kind='agent' AND sender_agent IS NOT NULL)));
      CREATE TABLE journal_head (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL, last_activity_at TEXT);
      CREATE TABLE journal_snapshot (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL,
        received_at TEXT NOT NULL, payload BLOB NOT NULL, sender_kind TEXT NOT NULL CHECK(sender_kind='person'),
        sender_user TEXT NOT NULL, sender_agent TEXT, CHECK(sender_agent IS NULL));`);
    db.prepare('INSERT INTO journal_meta(key,value) VALUES(?,?),(?,?)').run('board', ID, 'format', format);
    db.prepare(`INSERT INTO journal_record(sequence,received_at,kind,payload,sender_kind,sender_user,sender_agent)
      VALUES(1,?,'move',?,'person','101',NULL),(2,?,'request',?,'agent','202','agent-opaque')`)
      .run('2026-10-08T10:00:00.000Z', Buffer.from([0, 255, 2, 128]),
        '2026-10-08T10:01:00.000Z', Buffer.from([9, 0, 250, 1]));
    db.prepare('INSERT INTO journal_head(slot,sequence,last_activity_at) VALUES(1,2,?)').run('2026-10-08T10:02:00.000Z');
    db.prepare(`INSERT INTO journal_snapshot(slot,sequence,received_at,payload,sender_kind,sender_user,sender_agent)
      VALUES(1,1,? ,?,'person','101',NULL)`).run('2026-10-08T10:00:30.000Z', Buffer.from([7, 0, 255, 3]));
  } finally { db.close(); }
  return path;
}

/** Return a deterministic logical snapshot of the original schema and rows. */
function databaseContents(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const tables = {};
    for (const name of ['journal_meta', 'journal_head', 'journal_record', 'journal_snapshot']) {
      tables[name] = db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all().map(row => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('base64') : value]),
      ));
    }
    return { schema, tables };
  } finally { db.close(); }
}

/** Allocate a private directory and remove SQLite sidecars after every journal handle closes. */
function privateDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-machine-journal-'));
  const opened = [];
  t.after(() => { for (const journal of opened) journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory,
    /** Reopen the real private journal through the production migration. */
    open(now = () => new Date('2026-10-09T12:00:00.000Z')) {
      const journal = createRelayJournal({ directory, boardId: ID, now });
      opened.push(journal);
      return journal;
    },
  };
}

test('[H7,H15] format-2 opaque history migrates to machine attribution without changing its records', (t) => {
  const box = privateDirectory(t);
  const path = createLegacyJournal(box.directory);
  const legacy = databaseContents(path);
  const journal = box.open();
  assert.equal(journal.board, ID);
  assert.equal(journal.latest(), 2, 'the existing sequence head survives migration');
  assert.equal(journal.activity(), '2026-10-08T10:02:00.000Z', 'the existing head activity timestamp survives migration');
  assert.deepEqual(journal.after().map(row => ({ sequence: row.sequence, receivedAt: row.receivedAt,
    kind: row.kind, bytes: row.bytes, sender: row.sender })), [
    { sequence: 1, receivedAt: '2026-10-08T10:00:00.000Z', kind: 'move', bytes: Buffer.from([0, 255, 2, 128]), sender: PERSON },
    { sequence: 2, receivedAt: '2026-10-08T10:01:00.000Z', kind: 'request', bytes: Buffer.from([9, 0, 250, 1]),
      sender: { kind: 'agent', userId: '202', agent: 'agent-opaque' } },
  ], 'legacy person and agent provenance and opaque bytes remain exact');
  assert.deepEqual(journal.snapshot(), {
    sequence: 1, receivedAt: '2026-10-08T10:00:30.000Z', kind: 'snapshot',
    sender: PERSON, bytes: Buffer.from([7, 0, 255, 3]),
  }, 'the historical person snapshot remains unchanged');
  const migrated = databaseContents(path);
  assert.equal(migrated.tables.journal_meta.find(row => row.key === 'format').value, '3');
  assert.equal(migrated.tables.journal_meta.find(row => row.key === 'board').value, ID);
  assert.equal(migrated.tables.journal_record.length, legacy.tables.journal_record.length);
  assert.equal(migrated.tables.journal_snapshot.length, legacy.tables.journal_snapshot.length);
  assert.equal(migrated.schema.some(row => row.name.endsWith('_v2')), false, 'migration leaves no renamed legacy table behind');

  const machineMove = journal.appendNext(Buffer.from([4, 240, 1]), 'move', MACHINE);
  assert.equal(machineMove.sequence, 3);
  assert.deepEqual(machineMove.sender, MACHINE);
  assert.deepEqual(journal.after(2)[0].bytes, Buffer.from([4, 240, 1]));
  assert.equal(journal.activity(), '2026-10-09T12:00:00.000Z');
  const checkpoint = journal.saveSnapshot(3, Buffer.from([0, 11, 0, 255]), MACHINE);
  assert.equal(checkpoint.sequence, 3);
  assert.deepEqual(checkpoint.sender, MACHINE);
  assert.deepEqual(checkpoint.bytes, Buffer.from([0, 11, 0, 255]));
  assert.deepEqual(journal.after(), [], 'machine snapshot compaction retains the existing head without old rows');

  journal.close();
  const restarted = box.open();
  assert.equal(restarted.latest(), 3);
  assert.equal(restarted.activity(), '2026-10-09T12:00:00.000Z');
  assert.deepEqual(restarted.snapshot().sender, MACHINE, 'machine attribution survives a real SQLite restart');
  assert.deepEqual(restarted.snapshot().bytes, Buffer.from([0, 11, 0, 255]));
  const afterRestart = restarted.appendNext(Buffer.from([5, 3, 1]), 'request', MACHINE);
  assert.equal(afterRestart.sequence, 4);
  assert.deepEqual(afterRestart.sender, MACHINE);
  assert.equal(restarted.latest(), 4);
});

test('[H7] unsupported journal formats refuse without rewriting legacy tables or bytes', (t) => {
  const box = privateDirectory(t);
  const path = createLegacyJournal(box.directory, '99');
  const before = databaseContents(path);
  assert.throws(() => box.open(), { code: 'RELAY_STORAGE' });
  assert.deepEqual(databaseContents(path), before, 'unsupported format metadata, table checks and opaque rows stay unchanged');
});
