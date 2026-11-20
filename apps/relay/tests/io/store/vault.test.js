/** The relay vault keeps one bounded ciphertext per account, refuses stale and rolled-back writes, and answers a byte-identical retry with the same revision [H5,H15,C7,#11073]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { createVaultStore } from '../../../src/io/store/vault.js';
import { VAULT_MAX_BYTES } from '../../../src/io/store/vault.js';

/** A private vault directory and store, removed with the test. */
function fixture(t) {
  const directory = privateFixtureFiles('pullboard-vault-').root;
  const store = createVaultStore({ directory });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}

/** The refusal code a call throws, or null when it returns. */
function refusal(call) {
  try { call(); } catch (error) { return error.code; }
  return null;
}

test('relay.io-store-vault.one-ciphertext-per-account: clause 1: the vault returns only the calling account ciphertext, root and revision, and a second account reads nothing [C7]', (t) => {
  const { store } = fixture(t);
  const bytes = Buffer.from('sealed-for-account-one');
  assert.deepEqual(store.write('account-1', { expected: 0, revision: 1, root: 'root-one', ciphertext: bytes }), { revision: 1 });
  assert.deepEqual(store.read('account-1'), { root: 'root-one', revision: 1, ciphertext: bytes });
  assert.equal(store.read('account-2'), null, 'a second account reads nothing');
  store.write('account-2', { expected: 0, revision: 1, root: 'root-two', ciphertext: Buffer.from('sealed-for-account-two') });
  assert.deepEqual(store.read('account-1').ciphertext, bytes, 'the second account wrote no change to the first');
  assert.equal(store.read('account-2').root, 'root-two');
  assert.equal(refusal(() => store.write('account-1', { expected: 1, revision: 2, root: 'root-one', ciphertext: Buffer.alloc(VAULT_MAX_BYTES + 1) })), 'VAULT_TOO_LARGE', 'a ciphertext over the cap is refused');
  assert.equal(store.read('account-1').revision, 1, 'the refused write changed nothing');
});

test('relay.io-store-vault.stale-and-rolled-back-writes: clause 2: a write at a stale revision is refused VAULT_CONFLICT and a write whose revision is lower than the stored one is refused VAULT_ROLLBACK [C7]', (t) => {
  const { store } = fixture(t);
  const sealed = (text) => ({ root: 'root-one', ciphertext: Buffer.from(text) });
  store.write('account-1', { expected: 0, revision: 1, ...sealed('one') });
  store.write('account-1', { expected: 1, revision: 2, ...sealed('two') });
  assert.equal(refusal(() => store.write('account-1', { expected: 1, revision: 3, ...sealed('stale') })), 'VAULT_CONFLICT', 'built on revision 1 while 2 is stored');
  assert.equal(refusal(() => store.write('account-1', { expected: 0, revision: 1, ...sealed('rolled back') })), 'VAULT_ROLLBACK', 'revision 1 is lower than the stored 2');
  assert.equal(refusal(() => store.write('account-1', { expected: 2, revision: 1, ...sealed('rolled back') })), 'VAULT_ROLLBACK', 'a revision lower than stored is a rollback even from the current base');
  assert.deepEqual(store.read('account-1'), { root: 'root-one', revision: 2, ciphertext: Buffer.from('two') }, 'refused writes changed nothing');
});

test('relay.io-store-vault.byte-identical-retry: clause 3: a byte-identical retry of the stored write returns the same revision without a second row [C7]', (t) => {
  const { directory, store } = fixture(t);
  const write = { expected: 0, revision: 1, root: 'root-one', ciphertext: Buffer.from('one') };
  assert.deepEqual(store.write('account-1', write), { revision: 1 });
  assert.deepEqual(store.write('account-1', write), { revision: 1 }, 'the retry answers the same revision');
  assert.equal(store.read('account-1').revision, 1);
  const rows = new DatabaseSync(join(directory, 'vault.sqlite'), { readOnly: true });
  try { assert.equal(rows.prepare('SELECT COUNT(*) AS n FROM vault WHERE account=?').get('account-1').n, 1, 'one row, not two'); } finally { rows.close(); }
  assert.equal(refusal(() => store.write('account-1', { ...write, ciphertext: Buffer.from('other') })), 'VAULT_CONFLICT', 'the same revision with other bytes is not a retry');
});
