/** Board writes hold the lock briefly and checkpoints never block a reader [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../../packages/store/index.js';
import { checkpointBoard } from '../../../../../packages/store/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { importBoard } from '../../../../../packages/store/index.js';
import { openBoard } from '../../../index.js';
import { DERIVED_SETTING } from '../../../../../packages/verify/index.js';
import { deleteDerived } from '../../../../../packages/verify/index.js';
import { derivedProofCounter } from '../../../../../packages/verify/index.js';
import { refreshCapacityOutsideWrite } from '../../../../../packages/verify/index.js';

// The counters are read from the derived database, which the dual write fills while this setting is on (#8910, #8961).
process.env[DERIVED_SETTING] = '1';

/** A real file board in a private directory, with some history so its proof counters are warm. */
function fileBoard(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-lock-hold-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'board.sqlite');
  // @pullboard-board-file locking: a second connection must not block on the first
  const board = openBoard(file);
  t.after(() => store.closeBoard(board));
  for (let n = 0; n < 40; n += 1) store.addItem(board, { by: 'coordinator', lane: 'core', title: `Load item ${n}` });
  return { dir, file, board };
}

/** Read one counter from the derived database, decoded, or null. */
const derived = (board, key) => derivedProofCounter(board, key);

test('a board whose counters are current opens for writing while another process holds the write lock [C7]', t => {
  const { file } = fileBoard(t);
  const holder = new DatabaseSync(file);
  t.after(() => holder.close());
  holder.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
  try {
    const started = performance.now();
    // @pullboard-board-file locking: a second connection must not block on the first
    const other = openBoard(file);
    const elapsed = performance.now() - started;
    store.closeBoard(other);
    assert.ok(elapsed < 1_000, `opening took ${Math.round(elapsed)} ms; it must not wait for the write lock`); // budget: declared 1 s write-lock ceiling of #2578; the old path waited the 10 s busy timeout
  } finally { holder.exec('ROLLBACK'); }
});

test('a move holds the write lock under 1 s and derives no capacity forecast inside it [C7]', t => {
  const { board } = fileBoard(t);
  const before = derived(board, 'capacity-snapshot');
  const started = performance.now();
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Timed write' });
  const held = performance.now() - started;
  assert.ok(id > 0);
  assert.ok(held < 1_000, `the write held its transaction ${Math.round(held)} ms`); // budget: declared 1 s write-lock ceiling of #2578; the old path waited the 10 s busy timeout
  assert.deepEqual(derived(board, 'capacity-snapshot'), before, 'the move did not rebuild the capacity forecast');
  const stored = refreshCapacityOutsideWrite(board, store.atomic, { force: true });
  assert.ok(stored.includes('capacity-snapshot'), 'background maintenance stores the forecast in its own short write');
  assert.notEqual(derived(board, 'capacity-snapshot'), null);
});

test('a checkpoint never blocks a reader, during or after it [C7]', t => {
  const { file, board } = fileBoard(t);
  const reader = new DatabaseSync(file, { readOnly: true });
  t.after(() => reader.close());
  reader.exec('PRAGMA busy_timeout = 0; BEGIN');
  const seen = reader.prepare('SELECT count(*) AS n FROM item').get().n;
  for (let n = 0; n < 20; n += 1) store.addItem(board, { by: 'coordinator', lane: 'core', title: `After the reader ${n}` });
  const started = performance.now();
  const result = checkpointBoard(board.db);
  assert.ok(performance.now() - started < 1_000, 'a passive checkpoint returns at once'); // budget: declared 1 s write-lock ceiling of #2578; the old path waited the 10 s busy timeout
  assert.equal(typeof result.walFrames, 'number');
  assert.equal(reader.prepare('SELECT count(*) AS n FROM item').get().n, seen, 'the open reader keeps its snapshot, unblocked');
  reader.exec('COMMIT');
  const fresh = new DatabaseSync(file, { readOnly: true });
  t.after(() => fresh.close());
  fresh.exec('PRAGMA busy_timeout = 0');
  assert.equal(fresh.prepare('SELECT count(*) AS n FROM item').get().n, seen + 20, 'a new reader sees every write with no wait');
});

test('clause 2: a counter rebuild on open and a board import derive no capacity forecast under the write lock [C7]', t => {
  const { dir, file, board } = fileBoard(t);
  const snapshot = exportBoard(board);
  board.db.prepare('DELETE FROM board_meta WHERE meta_key IN (?, ?)').run('local:proof-stats:v2:summary', 'local:proof-stats:v2:capacity-snapshot');
  deleteDerived(board, 'local:proof-stats:v2:summary');
  deleteDerived(board, 'local:proof-stats:v2:capacity-snapshot');
  // @pullboard-board-file persistence: reopening rebuilds the missing counters from the file
  const reopened = openBoard(file);
  t.after(() => store.closeBoard(reopened));
  assert.notEqual(derived(reopened, 'summary'), null, 'opening rebuilt the missing counters');
  assert.equal(derived(reopened, 'capacity-snapshot'), null, 'the rebuild on open left the forecast to background maintenance');
  // The derived database attaches to a file board only, so the import target is a file.
  // @pullboard-board-file persistence: the derived database attaches beside a board file only
  const replica = openBoard(join(dir, 'replica.sqlite'));
  t.after(() => store.closeBoard(replica));
  importBoard(replica, snapshot);
  assert.notEqual(derived(replica, 'summary'), null, 'the import rebuilt its counters');
  assert.equal(derived(replica, 'capacity-snapshot'), null, 'the import left the forecast to background maintenance');
});
