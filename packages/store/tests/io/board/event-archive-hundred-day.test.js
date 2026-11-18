/** @pullboard-test-input source-cell store */
/** On a seeded 100-day board the archiver leaves only open and recent events hot, and show, log and export read an archived thread as before [C7,#11004]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveOldEvents } from '../../../index.js';
import { closeBoard } from '../../../index.js';
import { events } from '../../../index.js';
import { exportBoard } from '../../../index.js';
import { itemThread } from '../../../index.js';
import { openKitBoard } from '../../fixtures/cell.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const DAYS = 100;
/** An ISO time the given days before the fake clock. */
const ago = days => new Date(NOW.getTime() - days * DAY).toISOString();

/** Run `work` with the board file's machine guards dropped, then put back exactly the SQL they had; the fixture files items no move reached. */
function unguarded(db, work) {
  const guards = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all();
  for (const { name } of guards) db.exec(`DROP TRIGGER "${name}"`);
  try { work(); } finally { for (const { sql } of guards) db.exec(sql); }
}

/** One item per day for 100 days, three events each: every tenth day's item is open, the rest verified that day. */
function hundredDayBoard(t) {
  const directory = temporaryDirectory('pullboard-event-archive-hundred-');
  const board = openKitBoard(join(directory, 'board.sqlite'));
  t.after(() => { closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const item = board.db.prepare(`INSERT INTO item (item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at)
    VALUES ('core', ?, ?, 'coordinator', ?, ?)`);
  const event = board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', ?, ?, ?)");
  const items = [];
  unguarded(board.db, () => {
    for (let day = 1; day <= DAYS; day += 1) {
      const status = day % 10 === 0 ? 'open' : 'verified';
      const id = Number(item.run(`day ${day}`, status, ago(day + 1), ago(day)).lastInsertRowid);
      items.push({ id, day, status, archived: status === 'verified' && day > 30 });
      for (const [index, kind] of ['add', 'note', 'accept'].entries()) event.run(ago(day + 1 - index / 4), kind, id, JSON.stringify({ day, step: index }));
    }
  });
  return { board, items };
}

test('store.io-board-event-archive-hundred-day.hot-table-keeps-open-and-recent: clause 1: after the archiver ran on a 100-day board, the event table holds only events of open and recently verified items and event_archive holds every older verified item event [C7,#11004]', t => {
  const { board, items } = hundredDayBoard(t);
  const older = items.filter(row => row.archived);
  const kept = items.filter(row => !row.archived);
  assert.ok(older.length > 50 && kept.length > 20, 'the seed has both kinds');
  assert.equal(archiveOldEvents(board, NOW, { enabled: true }).moved, older.length * 3);
  const hot = board.db.prepare('SELECT item_id, COUNT(*) AS n FROM event GROUP BY item_id').all();
  assert.deepEqual(hot.map(row => row.item_id).sort((a, b) => a - b), kept.map(row => row.id).sort((a, b) => a - b), 'only open and recent items stay hot');
  assert.ok(hot.every(row => row.n === 3), 'each kept item keeps all three events');
  const cold = board.db.prepare('SELECT item_id, COUNT(*) AS n FROM event_archive GROUP BY item_id').all();
  assert.deepEqual(cold.map(row => row.item_id).sort((a, b) => a - b), older.map(row => row.id).sort((a, b) => a - b), 'every older verified item is archived');
  assert.ok(cold.every(row => row.n === 3), 'each archived item has all three events');
});

test('store.io-board-event-archive-hundred-day.show-log-export-read-same: clause 2: on the 100-day board, events (log), itemThread (show) and exportBoard read an archived item thread identically to before archiving [C7,#11004]', t => {
  const { board, items } = hundredDayBoard(t);
  const older = items.filter(row => row.archived);
  const before = new Map(items.map(row => [row.id, { log: events(board, { itemId: row.id }), thread: itemThread(board, row.id) }]));
  const exportedBefore = exportBoard(board);
  archiveOldEvents(board, NOW, { enabled: true });
  for (const row of items) {
    assert.deepEqual(events(board, { itemId: row.id }), before.get(row.id).log, `log of day ${row.day}`);
    assert.deepEqual(itemThread(board, row.id), before.get(row.id).thread, `thread of day ${row.day}`);
  }
  const exported = exportBoard(board);
  const archivedIds = new Set(older.map(row => row.id));
  assert.equal(exported.tables.event.some(row => archivedIds.has(row.item_id)), false, 'the export event table lacks archived rows');
  const everyEvent = id => [...exported.tables.event, ...exported.tables.event_archive].filter(row => row.item_id === id).map(row => row.event_id).sort((a, b) => a - b);
  for (const row of older) assert.deepEqual(everyEvent(row.id), before.get(row.id).log.map(entry => entry.event_id), `export of day ${row.day}`);
  assert.equal(exported.tables.event.length + exported.tables.event_archive.length, exportedBefore.tables.event.length, 'the export holds every event once');
});
