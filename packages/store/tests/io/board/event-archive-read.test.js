/** @pullboard-test-input source-cell store */
/** An archived item's whole thread still reads, identical to before archiving, through the event reader and the item thread [C7,#9335]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveOldEvents } from '../../../index.js';
import { closeBoard } from '../../../index.js';
import { events } from '../../../index.js';
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

test('clause 1: after the archiver ran, the event reader returns an archived item\'s events in order, identical to before archiving [C7,#9335]', t => {
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

test('clause 2: show, log and export read the same thread for an archived item as for the same item unarchived [C7,#9335]', t => {
  const { board, ids } = seededBoard(t);
  const before = itemThread(board, ids.old);
  const untouched = itemThread(board, ids.open);
  assert.equal(before.length, 3);
  archiveOldEvents(board, NOW, { enabled: true });
  assert.deepEqual(itemThread(board, ids.old), before);
  assert.deepEqual(itemThread(board, ids.open), untouched, 'an item that did not archive reads as before');
});
