import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runItems } from '../packages/runners/src/shell/run.js';

/** runItems assigns its lazily loaded modules, so each binding must be declared [C7]. */
test('clause 1: runItems loads its lazy modules and reaches the main-checkout refusal without a ReferenceError [C7]', async () => {
  const io = { out() {}, err() {}, write() {}, stdout: { write() {} }, stderr: { write() {} } };
  const deps = { context: () => ({ info: { isMain: true }, io }) };
  await assert.rejects(() => runItems(io, {}, deps), (error) => {
    assert.notEqual(error.name, 'ReferenceError', error.message);
    assert.equal(error.code, 'MAIN_IS_COORDINATOR');
    return true;
  });
});
