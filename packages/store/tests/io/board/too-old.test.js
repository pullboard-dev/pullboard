/** A board older than one release back is refused untouched; a 0.9.3 board still upgrades [R4]. */
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';

/** The fixture options that open an existing board file. */
const at = (file) => ({ storage: 'file', purpose: 'migration', file });

/** A copy of a small real board with only its version markers set: the smallest honest old board. */
function boardAt(t, { version, stamp = true }) {
  const source = fixtureBoard(t, { storage: 'file', purpose: 'migration' });
  source.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const original = source.db.prepare('PRAGMA database_list').get().file;
  const directory = temporaryDirectory('pullboard-too-old-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  copyFileSync(original, file);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${version}`);
  if (!stamp) db.exec('PRAGMA application_id = 0');
  db.close();
  return file;
}

test('a board from before 0.9.3 is refused naming the 0.9.3 step, byte-identical after [R4]', (t) => {
  const file = boardAt(t, { version: 2 });
  const before = readFileSync(file);
  assert.throws(() => fixtureBoard(t, at(file)), (error) => {
    assert.equal(error.code, 'BOARD_TOO_OLD');
    assert.match(error.message, /before pullboard 0\.9\.3/u);
    assert.match(error.next, /open this board with pullboard 0\.9\.3 first/u);
    return true;
  });
  assert.ok(before.equals(readFileSync(file)), 'the refused board is byte-identical afterwards');
});

test('a 0.9.3 board still upgrades on open as today [R4]', (t) => {
  const board = fixtureBoard(t, at(boardAt(t, { version: 3, stamp: false })));
  assert.equal(board.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.notEqual(board.db.prepare('PRAGMA application_id').get().application_id, 0, 'the unstamped board was stamped');
});

test('a new board file is created, not refused [R4]', (t) => {
  assert.ok(fixtureBoard(t, { storage: 'file', purpose: 'migration' }));
});
