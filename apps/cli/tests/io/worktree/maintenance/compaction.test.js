/** The daily board compaction also archives the events of long-verified items, only with board.archiveEvents on [C7,#9339]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dailyBoardCompaction } from '../../../../src/io/worktree/maintenance/compaction.js';
import { openKitBoard } from '../../../fixtures/board.js';
import { privateFixtureFiles } from '../../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';
import { ARCHIVE_AFTER_DAYS } from '../../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../../packages/store/index.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
/** An ISO time the given days before the fake clock. */
const ago = days => new Date(NOW.getTime() - days * DAY).toISOString();

/** A file board holding one item verified long ago with two events and one open item with one, a machine home with the setting as given, and a ctx that opens that file. */
function world(t, archiveEvents) {
  const { root } = privateFixtureFiles('pullboard-compaction-archive-');
  const home = join(root, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, archiveEvents === undefined ? {} : { board: { archiveEvents } });
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before; });
  const file = join(root, 'board.sqlite');
  const seed = openKitBoard(file);
  const guards = seed.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all();
  for (const { name } of guards) seed.db.exec(`DROP TRIGGER "${name}"`);
  const item = seed.db.prepare(`INSERT INTO item (item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at)
    VALUES ('core', ?, ?, 'coordinator', ?, ?)`);
  const event = seed.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'note', ?, '{}')");
  const old = Number(item.run('old', 'verified', ago(ARCHIVE_AFTER_DAYS + 15), ago(ARCHIVE_AFTER_DAYS + 15)).lastInsertRowid);
  const open = Number(item.run('open', 'open', ago(ARCHIVE_AFTER_DAYS + 15), ago(ARCHIVE_AFTER_DAYS + 15)).lastInsertRowid);
  event.run(ago(ARCHIVE_AFTER_DAYS + 16), old);
  event.run(ago(ARCHIVE_AFTER_DAYS + 15), old);
  event.run(ago(ARCHIVE_AFTER_DAYS + 15), open);
  for (const { sql } of guards) seed.db.exec(sql);
  closeBoard(seed);
  const ctx = { info: { root, commonDir: root, isMain: true }, config: {}, file, io: { err() {} }, nativeBoard: { openBoard: () => openKitBoard(file) } };
  /** The row counts of the hot and archive tables, read through a fresh connection. */
  const counts = () => {
    const board = openKitBoard(file);
    try { return { hot: board.db.prepare('SELECT COUNT(*) AS n FROM event WHERE item_id = ?').get(old).n, archived: board.db.prepare('SELECT COUNT(*) AS n FROM event_archive').get().n }; }
    finally { closeBoard(board); }
  };
  return { ctx, counts };
}

test('cli.io-worktree-maintenance-compaction.daily-archives-events-when-on: clause 2: with board.archiveEvents on one daily compaction moves the events of an item verified over ARCHIVE_AFTER_DAYS ago to event_archive; with it off nothing moves [C7,#9339]', t => {
  const on = world(t, true);
  assert.deepEqual(on.counts(), { hot: 2, archived: 0 });
  const report = dailyBoardCompaction(on.ctx, { now: NOW.getTime() });
  assert.equal(report.error, undefined);
  assert.equal(report.ran, true);
  assert.equal(report.events, 2);
  assert.deepEqual(on.counts(), { hot: 0, archived: 2 });
  assert.equal(dailyBoardCompaction(on.ctx, { now: NOW.getTime() + 1000 }).ran, false, 'the once-a-day schedule holds: a second call the same day does nothing');
  for (const setting of [false, undefined]) {
    const off = world(t, setting);
    const result = dailyBoardCompaction(off.ctx, { now: NOW.getTime() });
    assert.equal(result.error, undefined);
    assert.equal(result.events, 0);
    assert.deepEqual(off.counts(), { hot: 2, archived: 0 });
  }
});
