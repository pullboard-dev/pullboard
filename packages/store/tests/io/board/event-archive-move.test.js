/** @pullboard-test-input source-cell store */
/** The archiver moves the events of items verified over 30 days ago into event_archive, only with board.archiveEvents on [C7,#9334]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../index.js';
import { archiveOldEvents } from '../../../index.js';
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

/** A real board holding four items (verified long ago, verified recently, open, landed long ago) with two events each, plus one itemless event. */
function seededBoard(t) {
  const directory = temporaryDirectory('pullboard-event-archive-move-');
  const board = openKitBoard(join(directory, 'board.sqlite'));
  t.after(() => { closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const item = board.db.prepare(`INSERT INTO item (item_lane, item_title, item_status, item_merged_commit, item_created_by, item_created_at, item_updated_at)
    VALUES ('core', ?, ?, ?, 'coordinator', ?, ?)`);
  const event = board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'note', ?, '{}')");
  const ids = {};
  unguarded(board.db, () => {
    for (const [name, status, merged, days] of [['oldVerified', 'verified', null, 45], ['recentVerified', 'verified', null, 5], ['open', 'open', null, 60], ['oldLanded', 'withdrawn', 'abc123', 40]]) {
      ids[name] = Number(item.run(name, status, merged, ago(days + 1), ago(days)).lastInsertRowid);
      event.run(ago(days + 1), ids[name]);
      event.run(ago(days), ids[name]);
    }
    event.run(ago(90), null);
  });
  return { board, ids };
}

/** Event ids by table, in order. */
function eventIds(board, table) {
  return board.db.prepare(`SELECT item_id FROM ${table} ORDER BY event_id`).all().map(row => row.item_id);
}

test('clause 1: with board.archiveEvents on and a fake clock, every event of items verified over 30 days ago moves to event_archive and open and recent items keep theirs [C7,#9334]', t => {
  const { board, ids } = seededBoard(t);
  const result = archiveOldEvents(board, NOW, { enabled: true });
  assert.equal(result.moved, 4);
  assert.deepEqual(eventIds(board, 'event_archive'), [ids.oldVerified, ids.oldVerified, ids.oldLanded, ids.oldLanded]);
  assert.deepEqual(eventIds(board, 'event').sort(), [null, ids.recentVerified, ids.recentVerified, ids.open, ids.open].sort());
  const archived = board.db.prepare('SELECT * FROM event_archive ORDER BY event_id').all();
  assert.ok(archived.every(row => row.event_archived_at === NOW.toISOString() && row.event_kind === 'note' && row.event_detail === '{}'));
  assert.equal(archiveOldEvents(board, NOW, { enabled: true }).moved, 0, 'a second run finds nothing more to move');
  assert.throws(() => board.db.exec('DELETE FROM event'), /APPEND_ONLY/u, 'the append-only guard is back after the archive');
});

test('clause 2: with board.archiveEvents off, the default, the archiver moves nothing and the event table is byte-identical [C7,#9334]', t => {
  const { board } = seededBoard(t);
  const before = JSON.stringify(board.db.prepare('SELECT * FROM event ORDER BY event_id').all());
  assert.deepEqual(archiveOldEvents(board, NOW, { enabled: false }), { moved: 0 });
  assert.deepEqual(archiveOldEvents(board, NOW, { enabled: 'yes' }), { moved: 0 });
  assert.equal(JSON.stringify(board.db.prepare('SELECT * FROM event ORDER BY event_id').all()), before);
  assert.equal(board.db.prepare('SELECT count(*) AS n FROM event_archive').get().n, 0);
});
