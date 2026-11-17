/** Real SQLite transaction capture stays with the asynchronous operation that requested it [H21]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  hostname,
  tmpdir,
} from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  atomic,
  closeBoard,
} from "../../../../../store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../fixtures/cell-board.js";
import { captureBoardChanges } from "../../../../../store/src/io/board/capture.js";
import { boardWriteHolderText } from "../../../../../store/src/io/board/write/lock.js";

/** A controlled handoff between operations; no clock or scheduler delay decides their order. */
function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

/** Apply captured native changesets to another actual SQLite file and read their complete payload. */
function capturedRows(file, changes) {
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)');
    for (const change of changes) assert.equal(db.applyChangeset(change), true);
    return db.prepare('SELECT meta_key, meta_value FROM board_meta ORDER BY meta_key').all().map(row => ({ ...row }));
  } finally { db.close(); }
}

test('interleaved asynchronous captures keep each real board transaction in its own operation [H21]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-capture-'));
  const a = openBoard(join(directory, 'a.sqlite'));
  const b = openBoard(join(directory, 'b.sqlite'));
  t.after(() => { closeBoard(a); closeBoard(b); rmSync(directory, { recursive: true, force: true }); });
  const bEntered = barrier();
  const aCommitted = barrier();
  const bCommitted = barrier();
  const first = captureBoardChanges(async () => {
    await bEntered.promise;
    atomic(a, () => a.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:a', 'only A'));
    aCommitted.release();
    await bCommitted.promise;
    return 'A';
  });
  const second = captureBoardChanges(async () => {
    bEntered.release();
    await aCommitted.promise;
    atomic(b, () => b.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:b', 'only B'));
    bCommitted.release();
    return 'B';
  });
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual([one.result, two.result], ['A', 'B']);
  assert.equal(one.changes.length, 1, 'A retains its transaction although B entered its capture before A wrote');
  assert.equal(two.changes.length, 1, 'B captures no transaction from A');
  assert.deepEqual(capturedRows(join(directory, 'copy-a.sqlite'), one.changes), [{ meta_key: 'capture:a', meta_value: 'only A' }]);
  assert.deepEqual(capturedRows(join(directory, 'copy-b.sqlite'), two.changes), [{ meta_key: 'capture:b', meta_value: 'only B' }]);
  assert.deepEqual(a.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'capture:%'").all().map(row => row.meta_value), ['only A']);
  assert.deepEqual(b.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'capture:%'").all().map(row => row.meta_value), ['only B']);
});


test('a native changeset serialization failure rolls back and preserves its error before the next capture [H21]', async t => {
  t.diagnostic(JSON.stringify({ node: process.version, host: hostname(), execPath: process.execPath,
    binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }));
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-capture-failure-'));
  const board = openBoard(join(directory, 'board.sqlite'));
  const original = board.db.createSession;
  t.after(() => { board.db.createSession = original; closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const failure = new Error('injected native session changeset failure');
  let closes = 0;
  /** Create the real SQLite session, but inject a failure at its serialization boundary. */
  board.db.createSession = function (...args) {
    const session = Reflect.apply(original, this, args);
    return {
      changeset() { throw failure; },
      close() { closes += 1; session.close(); },
    };
  };
  const captured = await captureBoardChanges(() => {
    let caught;
    try { atomic(board, () => board.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:refused', 'must roll back')); }
    catch (error) { caught = error; }
    board.db.createSession = original;
    const retained = board.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key='capture:refused'").get().n;
    atomic(board, () => board.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:next', 'committed normally'));
    return { caught, retained };
  });
  t.diagnostic(JSON.stringify({ originalError: captured.result.caught === failure, retainedRows: captured.result.retained, closedSessions: closes }));
  assert.equal(captured.result.caught, failure, 'serialization failure keeps its identity instead of an invalid rollback error');
  assert.equal(captured.result.retained, 0, 'the failed capture cannot leave its move committed');
  assert.equal(closes, 1, 'the failed native session is closed');
  assert.equal(captured.changes.length, 1, 'only the following successful outer transaction is published');
  assert.deepEqual(capturedRows(join(directory, 'copy.sqlite'), captured.changes), [{ meta_key: 'capture:next', meta_value: 'committed normally' }]);
});

/** A private native board whose lifetime includes every asynchronous assertion in its case. */
function fixture(t, name) {
  const directory = mkdtempSync(join(tmpdir(), `pullboard-capture-${name}-`));
  const board = openBoard(join(directory, 'board.sqlite'));
  t.after(() => { closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  return { directory, board };
}

test('a detached descendant cannot extend a capture after its result has returned [H21]', async t => {
  const { directory, board } = fixture(t, 'lifetime');
  const later = barrier();
  let descendant;
  const captured = await captureBoardChanges(() => {
    descendant = (async () => {
      await later.promise;
      atomic(board, () => board.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:late', 'outside the completed capture'));
    })();
    atomic(board, () => board.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:early', 'inside the capture'));
  });
  later.release();
  await descendant;
  assert.equal(captured.changes.length, 1, 'the returned capture remains immutable with respect to later transactions');
  assert.deepEqual(capturedRows(join(directory, 'copy.sqlite'), captured.changes), [{ meta_key: 'capture:early', meta_value: 'inside the capture' }]);
  assert.equal(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='capture:late'").get().meta_value, 'outside the completed capture');
});

test('a failed real SQLite COMMIT publishes no prepared changes and restores the next outer capture [H21]', async t => {
  const { directory, board } = fixture(t, 'commit');
  board.db.exec('PRAGMA foreign_keys=ON; CREATE TABLE capture_parent(id INTEGER PRIMARY KEY); CREATE TABLE capture_child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES capture_parent(id) DEFERRABLE INITIALLY DEFERRED)');
  const captured = await captureBoardChanges(() => {
    assert.throws(() => atomic(board, () => board.db.prepare('INSERT INTO capture_child VALUES (1, 99)').run()), /FOREIGN KEY constraint failed/u);
    assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM capture_child').get().n, 0, 'the transaction actually rolled back');
    atomic(board, () => board.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:after-rollback', 'committed'));
  });
  assert.equal(captured.changes.length, 1, 'a prepared changeset is published only when COMMIT succeeds');
  assert.deepEqual(capturedRows(join(directory, 'copy.sqlite'), captured.changes), [{ meta_key: 'capture:after-rollback', meta_value: 'committed' }]);
});

test('a native capture close failure cannot skip outer depth or write-observation cleanup [H21]', async t => {
  const { directory, board } = fixture(t, 'close');
  const original = board.db.createSession;
  board.writeContext = { command: 'capture-close-fixture', seat: 'capture-fixture' };
  t.after(() => { board.db.createSession = original; });
  const failure = new Error('injected native session close failure');
  /** Close the genuine session before reporting its injected cleanup failure. */
  board.db.createSession = function (...args) {
    const session = Reflect.apply(original, this, args);
    return { changeset() { return session.changeset(); }, close() { session.close(); throw failure; } };
  };
  const captured = await captureBoardChanges(() => {
    const result = atomic(board, () => {
      board.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:first', 'already committed');
      return 'committed successfully';
    });
    assert.equal(result, 'committed successfully', 'cleanup failure must not make a committed move look refused');
    board.db.createSession = original;
    atomic(board, () => board.db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('capture:next', 'new outer transaction'));
  });
  assert.equal(captured.changes.length, 2, 'the next transaction is outermost and captures its changes');
  assert.doesNotMatch(boardWriteHolderText(join(directory, 'board.sqlite')), /capture-close-fixture/u, 'no finished transaction retains an advisory holder');
  assert.deepEqual(capturedRows(join(directory, 'copy.sqlite'), captured.changes), [
    { meta_key: 'capture:first', meta_value: 'already committed' }, { meta_key: 'capture:next', meta_value: 'new outer transaction' },
  ]);
});
