/** Code older than the shared board refuses before its write lock, so it never crawls newer caches [A5]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../index.js';
import { events } from '../../../index.js';
import { register } from '../../../index.js';
import { openKitBoard } from '../../../../../apps/cli/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

/** Count the evidence a write would change: events and stored proof counters. */
function footprint(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      events: db.prepare('SELECT count(*) AS n FROM event').get().n,
      counters: db.prepare("SELECT count(*) AS n, coalesce(group_concat(meta_value, ''), '') AS v FROM board_meta WHERE meta_key LIKE 'local:proof-stats:%'").get(),
    };
  } finally { db.close(); }
}

/** Create a real board with one event, as trunk code would. */
function trunkBoard(t) {
  const directory = privateFixtureFiles('pullboard-ahead-').root;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'board.sqlite');
  const board = openKitBoard(file);
  try { register(board, { lane: 'coordinator', path: directory }); } finally { closeBoard(board); }
  return file;
}

test('clause 1: an old writer refuses UNMERGED_SCHEMA on a board with columns it does not declare, naming the way forward [A5]', t => {
  const file = trunkBoard(t);
  const trunk = new DatabaseSync(file);
  trunk.exec("ALTER TABLE item ADD COLUMN item_trunk_probe TEXT NOT NULL DEFAULT ''");
  trunk.close();
  assert.throws(() => openKitBoard(file, undefined, { isMain: false }), error => {
    assert.equal(error.code, 'UNMERGED_SCHEMA');
    assert.match(error.message, /older than the shared board/u);
    assert.match(error.message, /item\.item_trunk_probe/u);
    assert.match(error.next, /main checkout's pullboard/u);
    assert.match(error.next, /merge main into this worktree/u);
    return true;
  });
});

test('clause 2: the refusal returns in under 1 s while another writer holds the lock, and changes nothing [A5]', t => {
  const file = trunkBoard(t);
  const trunk = new DatabaseSync(file);
  trunk.exec("ALTER TABLE item ADD COLUMN item_trunk_probe TEXT NOT NULL DEFAULT ''");
  // Make the cache stale, as a newer writer's version would be to old code, so a warm would replay history.
  trunk.exec("DELETE FROM board_meta WHERE meta_key LIKE 'local:proof-stats:%summary'");
  trunk.close();
  const before = footprint(file);
  const holder = new DatabaseSync(file);
  holder.exec('BEGIN IMMEDIATE');
  const startedAt = Date.now();
  try {
    assert.throws(() => openKitBoard(file, undefined, { isMain: false }), { code: 'UNMERGED_SCHEMA' },
      'the open refuses on the schema, not BOARD_BUSY, so it never asked for the write lock');
  } finally { holder.exec('ROLLBACK'); holder.close(); }
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `refused in ${elapsed} ms, under 1 s`); // budget: ceiling is #5899's approved 1 s lock bar
  assert.deepEqual(footprint(file), before, 'no event and no proof-counter row changed');
});

// A branch with only its own extra columns is covered end to end by apps/cli/journeys/resume/board/schema.test.js.
test('clause 3: a non-owner whose code declares every shared column still opens and writes as before [A5]', t => {
  const file = trunkBoard(t);
  const board = openKitBoard(file, undefined, { isMain: false });
  try {
    const before = events(board).length;
    register(board, { lane: 'web', path: '/fixture/web' });
    assert.equal(events(board).length, before + 1, 'the ordinary write still lands');
  } finally { closeBoard(board); }
});
