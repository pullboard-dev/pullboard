/** @pullboard-test-input source-cell store */
/** Prepared writes bind earlier inserted ids and guard change counts, staying plain serializable data [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { commitPrepared } from '../../../../src/io/board/write/sequencer.js';
import { temporaryDirectory } from '../../../fixtures/tmp.js';

/** A fresh board file with parent and child tables and a machine home of its own, restored after the case. */
function fixture(t) {
  const directory = temporaryDirectory('pullboard-plan-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'home');
  const db = new DatabaseSync(join(directory, 'board.sqlite'));
  db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY, x TEXT NOT NULL); CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER, body TEXT)');
  t.after(() => {
    db.close();
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  return { board: { db }, db };
}

test('store.io-board-write-sequencer.plan-refs: clause 1: [C7] a ref or json refs param binds an earlier statement inserted id and keeps JSON key order', t => {
  const { board, db } = fixture(t);
  const statements = [
    { sql: 'INSERT INTO parent (x) VALUES (?)', params: ['a'] },
    { sql: 'INSERT INTO parent (x) VALUES (?)', params: ['b'] },
    { sql: 'INSERT INTO child (parent, body) VALUES (?, ?)', params: [{ ref: 1 }, { json: { z: 1, a: { id: 0 }, m: [] }, refs: { 'a.id': 0, z: 1 } }] },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(statements)), statements, 'the plan is plain serializable data');
  const results = commitPrepared(board, { move: 'probe', statements });
  assert.equal(results.length, 3);
  const row = db.prepare('SELECT parent, body FROM child').get();
  assert.equal(row.parent, 2);
  assert.equal(row.body, '{"z":2,"a":{"id":1},"m":[]}');
  for (const bad of [{ ref: 5 }, { ref: -1 }, { ref: 'x' }, { json: {}, refs: { a: 9 } }]) {
    assert.throws(() => commitPrepared(board, { statements: [{ sql: 'INSERT INTO child (parent) VALUES (?)', params: [bad] }] }), { code: 'PREPARED_WRITE_REQUIRED' });
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM child').get().n, 1);
});

test('store.io-board-write-sequencer.plan-expect: clause 2: [C7] a statement whose change count differs from its expect rolls the whole list back and refuses', t => {
  const { board, db } = fixture(t);
  const ok = commitPrepared(board, { statements: [{ sql: 'INSERT INTO parent (x) VALUES (?)', params: ['a'], expect: 1 }, { sql: 'UPDATE parent SET x = ? WHERE x = ?', params: ['b', 'a'], expect: 1 }] });
  assert.equal(ok.length, 2);
  assert.throws(() => commitPrepared(board, { statements: [
    { sql: 'INSERT INTO parent (x) VALUES (?)', params: ['c'], expect: 1 },
    { sql: 'UPDATE parent SET x = ? WHERE x = ?', params: ['d', 'missing'], expect: 1 },
  ] }), { code: 'PREPARED_WRITE_UNEXPECTED_CHANGES' });
  assert.equal(db.isTransaction, false);
  assert.deepEqual(db.prepare('SELECT x FROM parent').all().map(r => r.x), ['b']);
  assert.throws(() => commitPrepared(board, { statements: [{ sql: 'SELECT 1', expect: 'one' }] }), { code: 'PREPARED_WRITE_REQUIRED' });
});
