/** @pullboard-test-input source-cell store */
/** An archived item's whole thread still reads, identical to before archiving, through the event reader (what show and log read), the state build's thread and an export [C7,#9335]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveOldEvents } from '../../../index.js';
import { closeBoard } from '../../../index.js';
import { events } from '../../../index.js';
import { exportBoard } from '../../../index.js';
import { importBoard } from '../../../index.js';
import { itemThreads } from '../../../src/io/board.js';
import { itemThread } from '../../../index.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
/** An ISO time the given days before the fake clock. */
const ago = days => new Date(NOW.getTime() - days * DAY).toISOString();

/** Run `work` with the board file's machine guards dropped, then put back exactly the SQL they had; the fixture files items no move reached. */
function unguarded(db, work) {
  const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all();
  for (const { name } of guards) db.exec(`DROP TRIGGER "${name}"`);
  try { work(); } finally { for (const { sql } of guards) db.exec(sql); }
}

/** A board with one item verified 45 days ago and one open item, three events each, interleaved so ids alternate. */
function seededBoard(t) {
  const directory = temporaryDirectory('pullboard-event-archive-read-');
  const board = openKitBoard(join(directory, 'board.sqlite'));
  t.after(() => { closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const item = board.db.prepare(`INSERT INTO item (item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at)
    VALUES ('core', ?, ?, 'coordinator', ?, ?)`);
  const event = board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', ?, ?, ?)");
  const ids = {};
  unguarded(board.db, () => {
    ids.old = Number(item.run('old', 'verified', ago(50), ago(45)).lastInsertRowid);
    ids.open = Number(item.run('open', 'open', ago(50), ago(2)).lastInsertRowid);
    for (const [index, kind] of ['add', 'note', 'accept'].entries()) {
      event.run(ago(50 - index), kind, ids.old, JSON.stringify({ step: index }));
      event.run(ago(49 - index), kind, ids.open, JSON.stringify({ step: index }));
    }
  });
  return { board, ids };
}

test('store.io-board-event-archive-read.after-the-archiver-ran-the-event: clause 1: after the archiver ran, the event reader returns an archived item\'s events in order, identical to before archiving [C7,#9335]', t => {
  const { board, ids } = seededBoard(t);
  const before = events(board, { itemId: ids.old });
  assert.equal(before.length, 3);
  assert.equal(archiveOldEvents(board, NOW, { enabled: true }).moved, 3);
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event WHERE item_id = ?').get(ids.old).n, 0, 'the hot table no longer holds them');
  const after = events(board, { itemId: ids.old });
  assert.deepEqual(after, before);
  assert.deepEqual(after.map(row => row.event_id), [...after.map(row => row.event_id)].sort((a, b) => a - b), 'oldest first');
  assert.deepEqual(events(board, { itemId: ids.old, kinds: ['note'] }), before.filter(row => row.event_kind === 'note'));
  assert.deepEqual(events(board, { itemId: ids.old, last: 2 }), before.slice(-2));
  assert.deepEqual(events(board, { itemId: ids.old, since: before[1].event_at }), before.slice(1));
});

test('store.io-board-event-archive-read.show-log-and-export-read-the: clause 2: show, log and export read the same thread for an archived item as for the same item unarchived [C7,#9335]', t => {
  const { board, ids } = seededBoard(t);
  const before = itemThread(board, ids.old);
  const untouched = itemThread(board, ids.open);
  assert.equal(before.length, 3);
  archiveOldEvents(board, NOW, { enabled: true });
  assert.deepEqual(itemThread(board, ids.old), before);
  assert.deepEqual(itemThread(board, ids.open), untouched, 'an item that did not archive reads as before');
});

test('clause 3: the log reader returns an archived item\'s events with its kind, since and last filters, as before archiving [C7,#9335]', t => {
  const { board, ids } = seededBoard(t);
  const before = events(board, { itemId: ids.old });
  const filters = [{ kinds: ['add', 'accept'] }, { last: 1 }, { since: before[2].event_at }, { kinds: ['note'], last: 1 }];
  const expected = filters.map(filter => events(board, { itemId: ids.old, ...filter }));
  archiveOldEvents(board, NOW, { enabled: true });
  filters.forEach((filter, index) => assert.deepEqual(events(board, { itemId: ids.old, ...filter }), expected[index], JSON.stringify(filter)));
  assert.deepEqual(events(board, { itemId: ids.open }).map(row => row.event_kind), ['add', 'note', 'accept'], 'the open item still reads from the hot table');
});

test('clause 4: a state build\'s threads (itemThreads, cut from the hot history) match itemThread for an archived item [C7,#9335]', t => {
  const { board, ids } = seededBoard(t);
  const before = itemThread(board, ids.old);
  archiveOldEvents(board, NOW, { enabled: true });
  const hot = board.db.prepare('SELECT * FROM event ORDER BY event_id').all();
  assert.equal(hot.some(row => row.item_id === ids.old), false, 'the history a state build holds no longer has the archived events');
  const threads = itemThreads(board, [ids.old, ids.open], hot);
  assert.deepEqual(threads.get(ids.old), before);
  assert.deepEqual(threads.get(ids.open), itemThread(board, ids.open));
  assert.deepEqual(itemThreads(board, [ids.old], [...hot, ...events(board, { itemId: ids.old })]).get(ids.old), before, 'a history that still holds the events does not list them twice');
});

test('clause 5: an export of an archived board imports as a board whose archived item reads the same thread and events [C7,#9335]', t => {
  const { board, ids } = seededBoard(t);
  const eventsBefore = events(board, { itemId: ids.old });
  const threadBefore = itemThread(board, ids.old);
  archiveOldEvents(board, NOW, { enabled: true });
  const document = exportBoard(board);
  assert.equal(document.tables.event.some(row => row.item_id === ids.old), false, 'the event table of the export lacks the archived rows');
  assert.equal(document.tables.event_archive.filter(row => row.item_id === ids.old).length, 3, 'the archived rows travel in event_archive');
  const directory = temporaryDirectory('pullboard-event-archive-import-');
  const replica = openKitBoard(join(directory, 'replica.sqlite'));
  t.after(() => { closeBoard(replica); rmSync(directory, { recursive: true, force: true }); });
  importBoard(replica, document);
  assert.deepEqual(events(replica, { itemId: ids.old }), eventsBefore);
  assert.deepEqual(itemThread(replica, ids.old), threadBefore);
});
