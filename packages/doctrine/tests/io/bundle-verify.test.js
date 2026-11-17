/** A rule bundle verifies offline against the rule board's authorized keys and refuses a changed, unsigned or wrongly issued one [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { encodeBundle } from '../../src/logic/bundle/encode.js';
import { signBundle } from '../../src/io/bundle/verify.js';
import { verifyBundle } from '../../src/io/bundle/verify.js';

const RULES = { version: 1, originBoardId: 'board-a', revision: 3, rules: [{ id: 'R1', text: 'one' }] };
const pair = () => generateKeyPairSync('ed25519');
const keyOf = signed => signed.key;

test('doctrine.io-bundle-verify.clause-1-a-bundle-signed-by-an: clause 1: a bundle signed by an authorized key verifies with no network [C7]', () => {
  const { privateKey } = pair();
  const { bytes, digest } = encodeBundle(RULES);
  const signature = signBundle(bytes, privateKey);
  const result = verifyBundle({ bytes, digest, signatures: [signature] }, [keyOf(signature)]);
  assert.equal(result.digest, digest);
  assert.equal(result.issuer, signature.key);
});

test('doctrine.io-bundle-verify.clause-1-changed-bytes-refuse-bundle: clause 1: changed bytes refuse BUNDLE_BYTES_CHANGED with a next step [C7]', () => {
  const { privateKey } = pair();
  const { bytes, digest } = encodeBundle(RULES);
  const signature = signBundle(bytes, privateKey);
  const tampered = bytes.replace('"one"', '"ONE"');
  for (const bundle of [{ bytes: tampered, digest, signatures: [signature] }, { bytes: tampered, signatures: [signature] }]) {
    assert.throws(() => verifyBundle(bundle, [signature.key]), error => error.code === 'BUNDLE_BYTES_CHANGED' && /again/u.test(error.message));
  }
});

test('doctrine.io-bundle-verify.clause-1-a-signature-from-a-key-the-rule: clause 1: a signature from a key the rule board did not authorize refuses BUNDLE_WRONG_ISSUER with a next step [C7]', () => {
  const { bytes, digest } = encodeBundle(RULES);
  const stranger = signBundle(bytes, pair().privateKey);
  const authorized = signBundle(bytes, pair().privateKey).key;
  assert.throws(() => verifyBundle({ bytes, digest, signatures: [stranger] }, [authorized]),
    error => error.code === 'BUNDLE_WRONG_ISSUER' && /authorized key/u.test(error.message));
});

test('doctrine.io-bundle-verify.clause-2-an-unsigned-bundle-refuses: clause 2: an unsigned bundle refuses BUNDLE_UNSIGNED [C7]', () => {
  const { bytes, digest } = encodeBundle(RULES);
  const key = signBundle(bytes, pair().privateKey).key;
  for (const signatures of [undefined, []]) {
    assert.throws(() => verifyBundle({ bytes, digest, signatures }, [key]), error => error.code === 'BUNDLE_UNSIGNED');
  }
});
