/** @pullboard-test-input source-cell packages/moves */
/** The read-only reader builds the snapshot each recorded move saw, and tables are found by discovery [C7,#8070]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { listMoveTables } from '../../../index.js';
import { readMoveRecords } from '../../../index.js';

const files = privateFixtureFiles('pullboard-move-read-');
after(() => rmSync(files.root, { recursive: true, force: true }));
let count = 0;

/** A fixture board on real SQLite with the board's event table, removed after the test. */
function board() {
  const file = join(files.root, `board-${count += 1}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}')`);
  const add = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  add.run('2026-11-01T00:00:00.000Z', 'coordinator', 'add', 1, '{"after":"[]"}');
  add.run('2026-11-02T00:00:00.000Z', 'coordinator', 'add', 2, '{}');
  add.run('2026-11-10T00:00:00.000Z', 'core-1', 'claim', 1, '{"leaseUntil":"x"}');
  add.run('2026-11-10T01:00:00.000Z', 'core-1', 'submit', 1, 'not json');
  add.run('2026-11-10T02:00:00.000Z', 'coordinator', 'shout', null, '{}');
  db.close();
  return file;
}

test('clause 1: readMoveRecords returns one frozen snapshot per item move since the cut, with the history it saw [C7]', () => {
  const records = readMoveRecords(board(), { since: '2026-11-05T00:00:00.000Z' });
  assert.deepEqual(records.map(record => [record.event.id, record.move.kind]), [[3, 'claim'], [4, 'submit']]);
  assert.deepEqual(records[0].snapshot.history.map(event => event.kind), ['add'], 'the claim saw only the add before it');
  assert.deepEqual(records[1].snapshot.history.map(event => event.kind), ['add', 'claim']);
  assert.deepEqual(records[1].recorded.events, [{ kind: 'submit', by: 'core-1', detail: {} }], 'a damaged detail reads as empty');
  assert.equal(Object.isFrozen(records[0]) && Object.isFrozen(records[1].snapshot.history[0].detail), true);
  assert.equal(records[0].snapshot.revision, 2);
  assert.throws(() => readMoveRecords(board(), { since: 'never' }), error => error.code === 'READ_SINCE');
});

test('clause 2: the board file is byte-for-byte unchanged after a read [C7]', () => {
  const file = board();
  const before = readFileSync(file);
  readMoveRecords(file, { since: '2026-11-01T00:00:00.000Z' });
  assert.equal(Buffer.compare(before, readFileSync(file)), 0);
});

test('clause 3: listMoveTables finds every *.table.js under the cells logic folders with no central list [C7]', () => {
  const root = join(files.root, 'tree');
  for (const file of ['packages/a/src/logic/x.table.js', 'packages/b/src/logic/deep/y.table.js', 'packages/b/src/logic/plain.js', 'packages/c/src/io/z.table.js']) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  assert.deepEqual(listMoveTables(root), ['packages/a/src/logic/x.table.js', 'packages/b/src/logic/deep/y.table.js']);
  const mine = listMoveTables();
  assert.ok(mine.includes('packages/moves/src/logic/table/backbone.table.js') && mine.includes('packages/moves/src/logic/table/hop.table.js'));
});
