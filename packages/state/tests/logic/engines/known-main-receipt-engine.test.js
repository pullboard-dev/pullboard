/** A known main failure keeps the main receipt id that recorded it on the new engine; older rows keep their bytes [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWN_MAIN_RECEIPT_ENGINE } from '../../../light.js';
import { KNOWN_MAIN_RUNNING_FILE_ENGINE } from '../../../light.js';
import { submissionProof } from '../../../index.js';

const failure = { file: 'test/frozen.test.js', name: 'frozen case [G1]', signature: 'a'.repeat(64), item: 7 };
const proof = known => ({ version: 1, files: [], full: false, deferred: false, reason: '', knownMainFailures: { main: 'b'.repeat(40), failures: [known] } });

test('state.logic-engines-known-main-receipt-engine.a-known-main-failure-keeps-its-main: a known main failure keeps its main receipt id on the receipt engine [V4,B3,H16]', () => {
  const receipt = 'main-test:' + 'c'.repeat(40) + ':test/frozen.test.js:node test/runner.js';
  assert.deepEqual(submissionProof(proof({ ...failure, receipt }), KNOWN_MAIN_RECEIPT_ENGINE).knownMainFailures.failures, [{ ...failure, receipt }]);
  assert.throws(() => submissionProof(proof({ ...failure, receipt }), KNOWN_MAIN_RUNNING_FILE_ENGINE), { code: 'SUBMISSION_PROOF' }, 'an older engine never records the id');
  assert.throws(() => submissionProof(proof({ ...failure, receipt: 'two\nlines' }), KNOWN_MAIN_RECEIPT_ENGINE), { code: 'SUBMISSION_PROOF' });
  assert.throws(() => submissionProof(proof({ ...failure, receipt: '' }), KNOWN_MAIN_RECEIPT_ENGINE), { code: 'SUBMISSION_PROOF' });
});

test('state.logic-engines-known-main-receipt-engine.an-older-row-without-a-receipt-id: an older row without a receipt id replays unchanged on either engine [V4,B3,H16]', () => {
  for (const engine of [KNOWN_MAIN_RUNNING_FILE_ENGINE, KNOWN_MAIN_RECEIPT_ENGINE]) {
    assert.deepEqual(submissionProof(proof(failure), engine).knownMainFailures.failures, [failure]);
  }
});
