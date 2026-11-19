import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as store from '../../../../store/index.js';
import { openCellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { undoQueued } from '../../../src/io/relay/undo.js';
import { recordSchemaStamp } from '../../../../store/index.js';
import { SCHEMA_DIGEST } from '../../../../store/index.js';

/** A real board preserves undo's transaction, triggers and foreign-key behavior on each actual Node runtime. */
function fixture(t, schema) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-undo-compat-'));
  const board = openCellBoard(join(directory, 'board.sqlite'));
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  board.db.exec(schema);
  recordSchemaStamp(board.db, SCHEMA_DIGEST); // The explicit private fixture schema is trusted setup.
  return board;
}

/** Capture SQLite's actual changeset, rather than constructing its wire encoding by hand. */
function capture(db, sql) {
  const session = db.createSession();
  try {
    db.exec(sql);
    return { changes: [Buffer.from(session.changeset()).toString('base64')] };
  } finally { session.close(); }
}

/** Snapshot the values and lifecycle triggers which a refused undo must preserve. */
function image(board) {
  return {
    rows: board.db.prepare('SELECT * FROM sample ORDER BY id').all(),
    triggers: board.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_%' ORDER BY name").all(),
    counters: board.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
  };
}

test('outbox.undo.replaces-changed-values: outbox undo replaces changed values without losing composite bigint and blob keys [H21,H16]', t => {
  const board = fixture(t, 'CREATE TABLE sample (id INTEGER, token BLOB, value TEXT, PRIMARY KEY(id, token))');
  const key = 9007199254740993n;
  const token = Buffer.from([0, 255, 10]);
  board.db.prepare('INSERT INTO sample VALUES(?,?,?)').run(key, token, 'before');
  const session = board.db.createSession();
  board.db.prepare('UPDATE sample SET value=? WHERE id=? AND token=?').run('queued', key, token);
  const queued = { changes: [Buffer.from(session.changeset()).toString('base64')] };
  session.close();
  board.db.prepare('UPDATE sample SET value=? WHERE id=? AND token=?').run('later cursor', key, token);
  assert.equal(undoQueued(board, [queued]), null);
  assert.equal(board.db.prepare('SELECT value FROM sample WHERE id=? AND token=?').get(key, token).value, 'before');
});

test('outbox.undo.missing-row-rolls-back: outbox undo refuses a missing row and rolls back earlier inverses and trigger changes [H21,H16]', t => {
  const board = fixture(t, "CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(2,'before')");
  const first = capture(board.db, "INSERT INTO sample VALUES(1,'queued')");
  const second = capture(board.db, "UPDATE sample SET value='queued too' WHERE id=2");
  board.db.exec('DELETE FROM sample WHERE id=1');
  const before = image(board);
  assert.equal(undoQueued(board, [first, second]), 'a row it changed is gone');
  assert.deepEqual(image(board), before, 'the successful newest inverse is rolled back with the refused older one');
});

test('outbox.undo.occupied-row-kept: outbox undo never replaces an occupied row when restoring a deleted row [H21,H16]', t => {
  const board = fixture(t, "CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1,'removed')");
  const queued = capture(board.db, 'DELETE FROM sample');
  board.db.exec("INSERT INTO sample VALUES(1,'another owner')");
  const before = image(board);
  assert.equal(undoQueued(board, [queued]), 'a row it removed is back');
  assert.deepEqual(image(board), before);
});

test('outbox.undo.uniqueness-no-partial: outbox undo refuses a uniqueness constraint without retaining partial changes [H21,H16]', t => {
  const board = fixture(t, "CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT UNIQUE); INSERT INTO sample VALUES(1,'before'),(2,'other')");
  const queued = capture(board.db, "UPDATE sample SET value='queued' WHERE id=1");
  board.db.exec("UPDATE sample SET value='before' WHERE id=2");
  const before = image(board);
  assert.match(undoQueued(board, [queued]), /constraint/);
  assert.deepEqual(image(board), before);
});

test('outbox.undo.restores-changeset: outbox undo restores a whole changeset with cross-table foreign keys [H21,H16]', t => {
  const board = fixture(t, 'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1)');
  const queued = capture(board.db, 'DELETE FROM child; DELETE FROM parent');
  assert.equal(undoQueued(board, [queued]), null);
  assert.deepEqual(board.db.prepare('SELECT * FROM child').all().map(row => ({ ...row })), [{ id: 1, parent: 1 }]);
  assert.deepEqual(board.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('outbox.undo.foreign-key-conflict: outbox undo refuses a foreign key conflict and restores its transaction [H21,H16]', t => {
  const board = fixture(t, 'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE sample (id INTEGER PRIMARY KEY, value INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1),(2); INSERT INTO sample VALUES(1,1)');
  const queued = capture(board.db, 'UPDATE sample SET value=2');
  board.db.exec('DELETE FROM parent WHERE id=1');
  const before = image(board);
  assert.match(undoQueued(board, [queued]), /foreign key/);
  assert.deepEqual(image(board), before);
  assert.deepEqual(board.db.prepare('PRAGMA foreign_key_check').all(), []);
});


test('outbox.undo.unterminated-header: outbox undo rejects an unterminated table header and rolls back its setup [H21,H16]', t => {
  const board = fixture(t, "CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1,'kept')");
  const before = image(board);
  const malformed = Buffer.from([0x54, 1, 1, 0x61]).toString('base64');
  assert.throws(() => undoQueued(board, [{ changes: [malformed] }]), /table header is incomplete/);
  assert.deepEqual(image(board), before);
});
