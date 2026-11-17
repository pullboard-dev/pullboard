/** @pullboard-test-input source-cell packages/spec */
/** Sign-off records are signed as canonical text and verify only against a listed SSH key [S17,S19,S20,S21]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';
import {
  SIGNOFF_NAMESPACE,
  canonical,
  listsPrincipal,
  makeSignature,
  verifySignature,
} from '../../index.js';

const ROW = { firstCommit: 'a'.repeat(40), initialHash: 'b'.repeat(64), id: 'G1', text: 'Exact row text is signed.', commit: 'c'.repeat(40), by: 'CO', on: '2026-11-09T00:00:00.000Z' };

/** Create a throwaway OpenSSH Ed25519 key pair under dir and return its private path and allowed-signers line. */
function makeKey(dir, name, principal) {
  const path = join(dir, name);
  const made = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test@example.invalid', '-f', path], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const [type, blob] = readFileSync(`${path}.pub`, 'utf8').trim().split(/\s+/u);
  return { path, line: `${principal} namespaces="${SIGNOFF_NAMESPACE}" ${type} ${blob}\n` };
}

/** Run one test against a scratch directory holding two keys, removed afterward. */
function withKeys(t) {
  const dir = privateFixtureFiles('pullboard-spec-signature-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, co: makeKey(dir, 'co', 'CO'), ab: makeKey(dir, 'ab', 'AB') };
}

test('spec.signature.canonical-field-order: [S19,S20] canonical text fixes the field order per record type and defaults the note', () => {
  assert.deepEqual(Object.keys(JSON.parse(canonical(ROW))), ['version', 'type', 'firstCommit', 'initialHash', 'id', 'text', 'commit', 'by', 'on', 'note']);
  assert.equal(JSON.parse(canonical(ROW)).note, '');
  assert.equal(canonical({ ...ROW, note: 'ok' }) === canonical(ROW), false, 'the note is signed content');
  const signers = { type: 'signers', firstCommit: ROW.firstCommit, initialHash: ROW.initialHash, previousHash: 'p', previousSigners: 'q', hash: 'h', by: 'CO', on: ROW.on };
  assert.deepEqual(Object.keys(JSON.parse(canonical(signers))), ['version', 'type', 'firstCommit', 'initialHash', 'previousHash', 'previousSigners', 'hash', 'by', 'on']);
});

test('spec.signature.verifies-listed-key: [S17,S19] a signature verifies for the listed key and fails once the signed text changes', (t) => {
  const { dir, co } = withKeys(t);
  const record = { ...ROW, signature: makeSignature(dir, ROW, co.path) };
  assert.equal(verifySignature(record, co.line), true);
  assert.throws(() => verifySignature({ ...record, text: 'Edited row text.' }, co.line), error => error.code === 'BAD_SIGNATURE');
  assert.throws(() => verifySignature({ ...record, note: 'added later' }, co.line), error => error.code === 'BAD_SIGNATURE');
});

test('spec.signature.rejects-other-key: [S19,S21] a signature never verifies against another key or an unlisted label', (t) => {
  const { dir, co, ab } = withKeys(t);
  const record = { ...ROW, signature: makeSignature(dir, ROW, co.path) };
  assert.throws(() => verifySignature(record, ab.line.replace('AB', 'CO')), error => error.code === 'BAD_SIGNATURE', 'another key under the same label');
  assert.throws(() => verifySignature({ ...record, by: 'AB' }, co.line + ab.line), error => error.code === 'BAD_SIGNATURE', 'a label whose key did not sign');
  assert.throws(() => verifySignature(record, ''), error => error.code === 'BAD_SIGNATURE', 'an empty signer list');
});

test('spec.signature.principal-listing: [S18,S21] a principal is listed by an uncommented line, alone or among comma-separated names', () => {
  const text = '# CO commented out\n\nAB,CD namespaces="pullboard-signoff" ssh-ed25519 AAAA\nEF ssh-ed25519 BBBB\n';
  assert.equal(listsPrincipal(text, 'AB'), true);
  assert.equal(listsPrincipal(text, 'CD'), true);
  assert.equal(listsPrincipal(text, 'EF'), true);
  assert.equal(listsPrincipal(text, 'CO'), false);
  assert.equal(listsPrincipal('', 'CO'), false);
});
