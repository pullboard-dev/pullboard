/** A closed board connection is released from memory even after its proof counters were read (#6586). */
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { proofCounter } from '../../src/io/proof/counters.js';

test('verify.proof.counter-release: [C7] proofCounter keeps no prepared statement alive past its connection closing', async () => {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc');
  const refs = [];
  for (let at = 0; at < 20; at++) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
    assert.equal(proofCounter({ db }, 'absent'), null);
    db.close();
    refs.push(new WeakRef(db));
  }
  for (let round = 0; round < 3; round++) { await new Promise((done) => setImmediate(done)); collect(); }
  // One connection may linger in a native cache; twenty means each closed connection was kept.
  assert.ok(refs.filter((ref) => ref.deref()).length <= 2, 'closed connections stay in memory');
});
