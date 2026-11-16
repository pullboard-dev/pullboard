/** The receipt cell answers main-red status from keyed receipts and checks runner-signed results, purely [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { test } from 'node:test';
import { MAIN_TEST_JOB } from '../index.js';
import { checkSignedResult } from '../index.js';
import { classifyMainRed } from '../index.js';
import { comparisonStatus } from '../index.js';
import { mainRedKey } from '../index.js';
import { mainRedStatus } from '../index.js';
import { mainTestJobId } from '../index.js';
import { resultStatement } from '../index.js';
import { runnerKeyId } from '../index.js';

const at = { tree: 't1', file: 'a.test.js', command: 'node --test' };
const redReceipt = { id: 'r1', ...at, verdict: 'red', failing: ['case a'] };

test('receipt.main-key.job: [C7] a main-red key is tree, file and command, and one key makes one job id', () => {
  const key = mainRedKey('t1', 'a.test.js', 'node --test');
  assert.equal(key, 't1:a.test.js:node --test');
  assert.equal(mainTestJobId(key), `${MAIN_TEST_JOB}:${key}`);
  for (const bad of [['', 'f', 'c'], ['t', '', 'c'], ['t', 'f', '']]) assert.throws(() => mainRedKey(...bad), { code: 'MAIN_RED_KEY' });
});

test('receipt.main-status.receipt-only: [C7] main status comes from the receipt alone, and none is missing', () => {
  assert.deepEqual(mainRedStatus([redReceipt], at), { key: mainRedKey(at.tree, at.file, at.command), status: 'red', receipt: 'r1', failing: ['case a'] });
  assert.equal(mainRedStatus([{ ...redReceipt, verdict: 'green' }], at).status, 'green');
  assert.equal(mainRedStatus([], at).status, 'missing');
  assert.equal(mainRedStatus([redReceipt], { ...at, tree: 't2' }).status, 'missing');
  const row = { file: 'a.test.js', result: 'red', receiptId: 'r9', failures: [{ file: 'a.test.js', name: 'x' }, { file: 'b.test.js', name: 'y' }] };
  assert.deepEqual(comparisonStatus(row, 'a.test.js').failing, ['x']);
  assert.equal(comparisonStatus(null).status, 'missing');
});

test('receipt.main-classify.owner: [C7] reds all on main are main\'s own; any other red is the candidate\'s; no receipt is unknown', () => {
  const main = mainRedStatus([redReceipt], at);
  assert.deepEqual(classifyMainRed(['case a'], main), { owner: 'main', receipt: 'r1', own: [], code: 'MAIN_OWN_RED' });
  assert.deepEqual(classifyMainRed(['case a', 'case b'], main), { owner: 'candidate', receipt: 'r1', own: ['case b'], code: 'CANDIDATE_RED' });
  assert.equal(classifyMainRed(['case a'], mainRedStatus([], at)).code, 'MAIN_RECEIPT_MISSING');
  assert.throws(() => classifyMainRed([], main), { code: 'MAIN_RED_REDS' });
});

/** One fresh Ed25519 runner key and a result file for one job, shard and tree. */
const posted = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { bytes: Buffer.from('{"ok":true}'), key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), privateKey, fields: { job: 'j1', shard: 's1', tree: 't1' } };
};

test('receipt.signed.statement: [C7] the signed statement is the length-prefixed PBSIGNED 2 form binding job, shard, tree, digest, base, tooling, command and attempt (#8035); the key id is a sha256 hex', () => {
  assert.equal(resultStatement({ job: 'j', shard: 's', tree: 't', digest: 'd' }), ['PBSIGNED 2', 'j', 's', 't', 'd', '', '', '', ''].map(v => `${v.length}:${v}`).join('\n'));
  assert.equal(resultStatement({ job: 'j', shard: 's', tree: 't', digest: 'd', base: 'b', tooling: 'o', command: 'c', attempt: 2 }), ['PBSIGNED 2', 'j', 's', 't', 'd', 'b', 'o', 'c', '2'].map(v => `${v.length}:${v}`).join('\n'));
  const { key } = posted();
  assert.match(runnerKeyId(key), /^[0-9a-f]{64}$/u);
  assert.equal(runnerKeyId(key), runnerKeyId(key));
});

test('receipt.signed.check: [C7] a good signature passes; missing, unsigned, malformed and foreign ones are import.invalid, never red', () => {
  const { bytes, key, privateKey, fields } = posted();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const signature = sign(null, Buffer.from(resultStatement({ ...fields, digest })), privateKey).toString('base64url');
  const ok = checkSignedResult({ bytes, signature, publicKey: key, ...fields });
  assert.deepEqual([ok.valid, ok.digest, ok.keyId], [true, digest, runnerKeyId(key)]);
  const bad = (over) => checkSignedResult({ bytes, signature, publicKey: key, ...fields, ...over });
  for (const result of [bad({ bytes: null }), bad({ publicKey: undefined }), bad({ signature: '' }), bad({ signature: 'short' }), bad({ tree: 't2' }), bad({ bytes: Buffer.from('other') })]) {
    assert.deepEqual([result.valid, result.outcome, result.code], [false, 'infra', 'import.invalid']);
  }
});
