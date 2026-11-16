/** @pullboard-test-input source-cell store */
/** The board schema holds an event_archive table that older events can move into; this slice only adds the table [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { closeBoard } from '../../../index.js';
import { logEvent } from '../../../index.js';
import { register } from '../../../index.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

const EVENT_COLUMNS = ['event_id', 'event_at', 'event_by', 'event_kind', 'item_id', 'event_detail'];

/** Column names of one table in a board file, read without pullboard. */
function columns(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(entry => entry.name); } finally { db.close(); }
}

/** Every event row of a board file, read without pullboard. */
function eventRows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT * FROM event ORDER BY event_id').all(); } finally { db.close(); }
}

/** A real board file with a registered seat and a few events. */
function boardFile(t) {
  const directory = temporaryDirectory('pullboard-event-archive-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const board = openKitBoard(file);
  try {
    register(board, { lane: 'coordinator', path: directory });
    logEvent(board, 'coordinator', 'note', null, { text: 'one' });
    logEvent(board, 'coordinator', 'note', null, { text: 'two' });
  } finally { closeBoard(board); }
  return file;
}

test('clause 1: a fresh board has an event_archive table with the event columns plus the archive time [C7]', t => {
  const file = boardFile(t);
  assert.deepEqual(columns(file, 'event_archive'), [...EVENT_COLUMNS, 'event_archived_at']);
  assert.equal(eventRows(file).length >= 2, true);
});

test('clause 1: a board from the previous schema gains event_archive on open and no existing row changes [C7]', t => {
  const file = boardFile(t);
  const before = eventRows(file);
  const old = new DatabaseSync(file);
  try { old.exec('DROP TABLE event_archive'); } finally { old.close(); }
  assert.deepEqual(columns(file, 'event_archive'), []);
  closeBoard(openKitBoard(file));
  assert.deepEqual(columns(file, 'event_archive'), [...EVENT_COLUMNS, 'event_archived_at']);
  assert.deepEqual(eventRows(file), before);
});

test('clause 2: the archive table starts empty so the hot event table is the only history [C7]', t => {
  const file = boardFile(t);
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM event_archive').get().n, 0); } finally { db.close(); }
});
