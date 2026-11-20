/** A PRF output is accepted only as exactly 32 bytes [H5,#11075]. @pullboard-test-input source-cell apps/relay */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prfOutput } from '../../../src/logic/browser/prf.js';

/** Run work and return the refusal code it throws. */
function codeOf(work) {
  try {
    work();
  } catch (error) {
    return error.code;
  }
  return null;
}

test('relay.logic-browser-prf.returns-first-result: clause 1: prfOutput(credentialResult) returns the 32 bytes of extension result prf.results.first and refuses PRF_MISSING when the extension result is absent [H5,#11075]', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
  const out = prfOutput({ prf: { results: { first: bytes.buffer } } });
  assert.deepEqual([...out], [...bytes]);
  assert.notEqual(out.buffer, bytes.buffer);
  assert.deepEqual([...prfOutput({ prf: { results: { first: bytes } } })], [...bytes]);
  assert.equal(codeOf(() => prfOutput({})), 'PRF_MISSING');
  assert.equal(codeOf(() => prfOutput({ prf: { enabled: true } })), 'PRF_MISSING');
});

test('relay.logic-browser-prf.exactly-32-bytes: clause 2: prfOutput refuses PRF_LENGTH for any output that is not exactly 32 bytes [H5,#11075]', () => {
  for (const length of [0, 16, 31, 33, 64]) {
    assert.equal(codeOf(() => prfOutput({ prf: { results: { first: new Uint8Array(length) } } })), 'PRF_LENGTH');
  }
  assert.equal(codeOf(() => prfOutput({ prf: { results: { first: 'text' } } })), 'PRF_LENGTH');
});
