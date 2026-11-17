/** The board's run table is additive: an open adds it and its indexes, changes nothing else, and export carries its rows [R2,S2,B2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellSandbox } from '../../../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../fixtures/cell-board.js';
import { openCellBoard } from '../../../fixtures/cell-board.js';
import { exportBoard } from '../../../../../store/index.js';
import { importBoard } from '../../../../../store/index.js';
import { RUN_OBJECT_NAMES } from '../../../../../store/index.js';
import { ensureGateHopTable } from '../../../../../store/index.js';

/** Every schema object on the board except the run table's own (its key index included) and SQLite's statistics tables, by name, with its SQL. */
function otherObjects(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'run' AND name NOT LIKE 'sqlite_stat%' ORDER BY type, name").all().map(row => ({ ...row }));
}

/** The names of objects added, removed or rewritten between two schema listings, for a readable failure. */
function changedNames(before, after) {
  const key = row => `${row.type}:${row.name}`;
  const was = new Map(before.map(row => [key(row), row.sql]));
  const now = new Map(after.map(row => [key(row), row.sql]));
  return [...new Set([...was.keys(), ...now.keys()])].filter(name => was.get(name) !== now.get(name)).sort();
}

/** The run rows of a board, in a stable order. */
function runRows(db) {
  return db.prepare('SELECT * FROM run ORDER BY run_job').all().map(row => ({ ...row }));
}

test('board.run.board-opens-with-the-run-table: a board opens with the run table, its columns and its two indexes [R2,S2]', t => {
  const board = cellBoard(t, ':memory:');
  const columns = board.db.prepare('PRAGMA table_info(run)').all().map(row => row.name);
  assert.deepEqual(columns, ['run_job', 'run_kind', 'run_item', 'run_candidate', 'run_base', 'run_state', 'run_attempt', 'run_outcome',
    'run_summary', 'run_record', 'run_lease_owner', 'run_lease_until', 'run_created', 'run_updated']);
  for (const name of RUN_OBJECT_NAMES) assert.ok(board.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), `${name} is installed`);
  assert.equal(board.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'run_open'").get().sql.includes("WHERE run_state IN ('queued', 'awaiting')"), true);
  board.db.prepare("INSERT INTO run (run_job, run_kind, run_state, run_created, run_updated) VALUES ('gate:1:a:t', 'gate', 'queued', 1, 1)").run();
  assert.throws(() => board.db.prepare("INSERT INTO run (run_job, run_kind, run_state, run_created, run_updated) VALUES ('gate:1:a:t', 'gate', 'queued', 2, 2)").run(),
    /UNIQUE|PRIMARY KEY/u, 'a run id is never reused');
});

test('board.run.board-without-the-run-table-gains: a board without the run table gains it on its next open, and no other table, index or version changes [R2,S2]', t => {
  const file = join(cellSandbox(t).dir, 'board.sqlite');
  const first = openCellBoard(file);
  // The fenced hop creates the hop table on a live board, so this board has it and only the run table is missing (#8465).
  ensureGateHopTable(first.db);
  first.db.exec('DROP TABLE run');
  const before = otherObjects(first.db);
  const version = first.db.prepare('PRAGMA user_version').get().user_version;
  closeCellBoard(first);
  const again = openCellBoard(file);
  t.after(() => closeCellBoard(again));
  for (const name of RUN_OBJECT_NAMES) assert.ok(again.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), `${name} is back`);
  assert.deepEqual(changedNames(before, otherObjects(again.db)), [], 'the upgrade only adds the run table and its indexes');
  assert.equal(again.db.prepare('PRAGMA user_version').get().user_version, version);
});

test('board.run.export-leaves-out-empty-run-table: export leaves out an empty run table and round-trips a board holding run rows [R2,S2]', t => {
  const empty = cellBoard(t, ':memory:');
  assert.equal(Object.hasOwn(exportBoard(empty).tables, 'run'), false, 'an empty run table is additive and left out');
  const source = cellBoard(t, ':memory:');
  source.db.prepare(`INSERT INTO run (run_job, run_kind, run_item, run_candidate, run_state, run_attempt, run_outcome, run_summary, run_record, run_created, run_updated)
    VALUES ('gate:7:abc:t', 'gate', 7, 'c', 'done', 1, 'green', '{"status":"green"}', '{"state":"done"}', 10, 20)`).run();
  source.db.prepare("INSERT INTO run (run_job, run_kind, run_state, run_lease_owner, run_lease_until, run_created, run_updated) VALUES ('review:8', 'review', 'queued', 'seat-1', 99, 30, 30)").run();
  const document = exportBoard(source);
  assert.equal(document.tables.run.length, 2);
  const target = cellBoard(t, ':memory:');
  importBoard(target, document);
  assert.deepEqual(runRows(target.db), runRows(source.db), 'run rows survive export and import unchanged');
});
