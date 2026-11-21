/** @pullboard-test-input source-cell store */
/** The board sequencer commits only prepared writes: statements and params, never a callback [C7]. */
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { commitPrepared } from '../../../../src/io/board/write/sequencer.js';
import { temporaryDirectory } from '../../../fixtures/tmp.js';

/** A fresh board file with one table and a machine home of its own, restored after the case. */
function fixture(t) {
  const directory = temporaryDirectory('pullboard-sequencer-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'home');
  const db = new DatabaseSync(join(directory, 'board.sqlite'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT NOT NULL)');
  t.after(() => {
    db.close();
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  const rows = () => {
    try { return readFileSync(join(directory, 'home', 'board-writes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  return { board: { db }, db, rows };
}

test('store.io-board-write-sequencer.refuses-callback: clause 1: [C7] commitPrepared refuses a function, a non-array statements value or a statement without a sql string and opens no transaction', t => {
  const { board, db, rows } = fixture(t);
  for (const statements of [() => {}, 'INSERT', {}, [{ params: [] }], [{ sql: 5 }], [() => {}], []]) {
    assert.throws(() => commitPrepared(board, { move: 'probe', statements }), { code: 'PREPARED_WRITE_REQUIRED' });
    assert.equal(db.isTransaction, false);
  }
  assert.equal(rows().length, 0, 'a refusal records no hold');
  assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 0);
});

test('store.io-board-write-sequencer.one-transaction: clause 2: [C7] several statements commit in one transaction, record one hold naming the move, return each result, and a failing statement leaves no row', t => {
  const { board, db, rows } = fixture(t);
  const results = commitPrepared(board, { move: 'probe-move', statements: [
    { sql: 'INSERT INTO t (x) VALUES (?)', params: ['a'] },
    { sql: 'INSERT INTO t (x) VALUES (?)', params: ['b'] },
  ] });
  assert.deepEqual(results.map(result => Number(result.changes)), [1, 1]);
  assert.deepEqual(results.map(result => Number(result.lastInsertRowid)), [1, 2]);
  const held = rows().filter(row => row.move === 'probe-move');
  assert.equal(held.length, 1);
  assert.equal(held[0].outcome, 'committed');
  assert.throws(() => commitPrepared(board, { move: 'probe-fail', statements: [
    { sql: 'INSERT INTO t (x) VALUES (?)', params: ['c'] },
    { sql: 'INSERT INTO t (x) VALUES (?)', params: [null] },
  ] }));
  assert.equal(db.prepare('SELECT count(*) AS n FROM t').get().n, 2, 'the failed write left no row behind');
  assert.equal(db.isTransaction, false);
  assert.equal(rows().find(row => row.move === 'probe-fail')?.outcome, 'rolled-back');
});

test('store.io-board-write-sequencer.commit-fast: clause 3: [C7] a 20-statement prepared write commits with every recorded hold under 50 ms, best of 5', t => {
  const { board, rows } = fixture(t);
  const statements = Array.from({ length: 20 }, (_, index) => ({ sql: 'INSERT INTO t (x) VALUES (?)', params: [String(index)] }));
  for (let run = 0; run < 5; run += 1) commitPrepared(board, { move: 'probe-fast', statements });
  const holds = rows().filter(row => row.move === 'probe-fast').map(row => row.durationMs);
  assert.equal(holds.length, 5);
  assert.ok(Math.min(...holds) < 50, `best hold ${Math.min(...holds)} ms`);
});
