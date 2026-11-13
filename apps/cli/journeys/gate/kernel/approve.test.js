/** @pullboard-test-input apps/lib/src/logic/native.js packages/kernel/index.js packages/kernel/light.js packages/store/index.js */
/** A Kernel door change reaches the pulled submit gate only with the person's exact consent [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { kernelGateChange } from '../../../../../packages/verify/index.js';
import { kernelApprovalText } from '../../../../../packages/verify/index.js';
import { requireKernelApproval } from '../../../../../packages/verify/index.js';
import * as store from '../../../../../packages/store/index.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { put } from '../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { fixture } from '../../../tests/fixtures/submit/kernel.js';
import { settleBox } from '../../../tests/fixtures/submit/kernel.js';
import { boardFor } from '../../../tests/fixtures/submit/kernel.js';
import { answer } from '../../../tests/fixtures/submit/kernel.js';

/** Require the guard's refusal, including its real changed-export diagnostics. */
function refused(box, commit, names) {
  assert.throws(() => boardFor(box, board => requireKernelApproval(board, { root: box.root, base: box.base, commit, item: 1 })), error => {
    assert.equal(error.code, 'KERNEL_EXPORT_APPROVAL');
    for (const name of names) assert.ok(error.message.includes(name), error.message);
    return true;
  });
}
test('only the person can approve the exact item and Kernel interface for submit [C7]', async t => {
  const box = fixture(t);
  put(box.root, 'packages/kernel/light.js', "export { one, two } from './src/logic/value.js';\n");
  const commit = commitAll(box, 'feat(kernel): expose pure two [G1]');
  const change = kernelGateChange(box.root, box.base, commit);
  const token = kernelApprovalText(1, change.digest);
  answer(box, token, false);
  refused(box, commit, ['two']);
  answer(box, kernelApprovalText(2, change.digest));
  refused(box, commit, ['two']);
  answer(box, token);
  boardFor(box, board => requireKernelApproval(board, { root: box.root, base: box.base, commit, item: 1 }));
  const result = await runCliInProcess(['submit', '1', '--no-next', '--json'], { cwd: box.root, env: box.env });
  assert.equal(result.code, 0, result.out + result.err);
  await settleSubmit(t, settleBox(box), JSON.parse(result.out));
  boardFor(box, board => assert.equal(store.getItem(board, 1).item_status, 'submitted'));
});
