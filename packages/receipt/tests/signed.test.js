/** The receipt cell's signed runner result is length-prefixed and bound to its attempt, base, tooling and command [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createHash } from 'node:crypto';
import { sign } from 'node:crypto';
import { test } from 'node:test';
import { resultStatement } from '../index.js';
import { checkSignedResult } from '../index.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const bytes = Buffer.from('PBRESULT 1 0 3\nok\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const bound = { job: 'j', shard: 's', tree: 't'.repeat(40), base: 'b'.repeat(40), tooling: 'p'.repeat(40), command: 'sh ./check.sh', attempt: '1' };
const signed = fields => sign(null, Buffer.from(resultStatement({ ...fields, digest })), keys.privateKey).toString('base64url');
const check = (signature, fields) => checkSignedResult({ bytes, signature, publicKey, ...fields });

test('receipt.signed.concat: [C7] a signed runner result whose fields are concatenated differently fails to verify', () => {
  assert.notEqual(resultStatement({ ...bound, job: 'a b', shard: 'c', digest }), resultStatement({ ...bound, job: 'a', shard: 'b c', digest }));
  assert.notEqual(resultStatement({ ...bound, command: 'x', attempt: '12', digest }), resultStatement({ ...bound, command: 'x1', attempt: '2', digest }));
  const signature = signed({ ...bound, job: 'a b', shard: 'c' });
  assert.equal(check(signature, { ...bound, job: 'a b', shard: 'c' }).valid, true);
  assert.equal(check(signature, { ...bound, job: 'a', shard: 'b c' }).valid, false);
});

test('receipt.signed.binding: [C7] a result signed for one attempt, base, tooling pin or command fails to verify for any other', () => {
  const signature = signed(bound);
  assert.equal(check(signature, bound).valid, true);
  for (const change of [{ attempt: '2' }, { base: 'c'.repeat(40) }, { tooling: 'q'.repeat(40) }, { command: 'sh ./other.sh' }]) {
    const other = check(signature, { ...bound, ...change });
    assert.deepEqual([other.valid, other.code], [false, 'import.invalid'], JSON.stringify(change));
  }
});

test('receipt.signed.types: [C7] clause 2: a public key or signature of the wrong type is import.invalid even when its text would pass', () => {
  const signature = signed(bound);
  const wrongKey = checkSignedResult({ bytes, signature, publicKey: [publicKey], ...bound });
  assert.deepEqual([wrongKey.valid, wrongKey.code, wrongKey.reason], [false, 'import.invalid', 'the board holds no registered key for this runner']);
  const wrongSignature = check([signature], bound);
  assert.deepEqual([wrongSignature.valid, wrongSignature.code, wrongSignature.reason], [false, 'import.invalid', 'the result file is unsigned']);
  assert.equal(check('', bound).reason, 'the result file is unsigned');
  assert.equal(check(signature, bound).valid, true);
});
