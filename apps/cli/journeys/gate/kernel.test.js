/** @pullboard-test-input apps/lib/src/logic/native.js packages/kernel/index.js packages/kernel/light.js packages/store/index.js */
/** Real committed Kernel contracts: the door refusal and approval scope, before any gate runs [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { kernelGateChange } from '../../../../packages/verify/index.js';
import { kernelApprovalText } from '../../../../packages/verify/index.js';
import { requireKernelApproval } from '../../../../packages/verify/index.js';
import * as store from '../../../../packages/store/index.js';
import { put } from '../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { fixture } from '../../tests/fixtures/submit/kernel.js';
import { boardFor } from '../../tests/fixtures/submit/kernel.js';
import { answer } from '../../tests/fixtures/submit/kernel.js';

/** Require the guard's refusal, including its real changed-export diagnostics. */
function refused(box, commit, names) {
  assert.throws(() => boardFor(box, board => requireKernelApproval(board, { root: box.root, base: box.base, commit, item: 1 })), error => {
    assert.equal(error.code, 'KERNEL_EXPORT_APPROVAL');
    for (const name of names) assert.ok(error.message.includes(name), error.message);
    return true;
  });
}

test('submit refuses a changed Kernel door and names exports before any test gate [C7]', async t => {
  const box = fixture(t);
  put(box.root, 'packages/kernel/index.js', "export { one, two } from './src/logic/value.js';\n");
  const commit = commitAll(box, 'feat(kernel): expose two [G1]');
  const change = kernelGateChange(box.root, box.base, commit);
  assert.deepEqual(change.changes, [{ file: 'packages/kernel/index.js', names: ['two'] }]);
  const result = await runCliInProcess(['submit', '1', '--no-next', '--json'], { cwd: box.root, env: box.env });
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'KERNEL_EXPORT_APPROVAL');
  assert.match(result.out, /two/u);
  boardFor(box, board => assert.equal(store.getItem(board, 1).item_status, 'claimed'));
});

test('person consent cannot carry to another export contract and a later decline revokes it [C7]', async t => {
  const box = fixture(t);
  put(box.root, 'packages/kernel/index.js', "export { one, two } from './src/logic/value.js';\n");
  const commit = commitAll(box, 'feat(kernel): expose two [G1]');
  const change = kernelGateChange(box.root, box.base, commit);
  answer(box, kernelApprovalText(1, change.digest));
  answer(box, kernelApprovalText(1, change.digest, false));
  refused(box, commit, ['two']);
  answer(box, kernelApprovalText(1, change.digest));
  put(box.root, 'packages/kernel/index.js', "export { one as renamed, two } from './src/logic/value.js';\n");
  const changed = commitAll(box, 'feat(kernel): rename one [G1]');
  refused(box, changed, ['one', 'renamed']);
});

test('star-forwarded public names are checked while private body changes preserve approval scope [C7]', async t => {
  const box = fixture(t);
  put(box.root, 'packages/kernel/index.js', "export * from './src/logic/value.js';\n");
  const before = commitAll(box, 'feat(kernel): forward the public module [G1]');
  put(box.root, 'packages/kernel/src/logic/value.js', 'export const one = 4;\nexport const two = 2;\n');
  const internal = commitAll(box, 'fix(kernel): preserve public identity [G1]');
  assert.equal(kernelGateChange(box.root, before, internal), null);
  put(box.root, 'packages/kernel/src/logic/value.js', 'export const one = 4;\nexport const two = 2;\nexport const three = 3;\n');
  const exposed = commitAll(box, 'feat(kernel): extend forwarded exports [G1]');
  assert.deepEqual(kernelGateChange(box.root, before, exposed).changes,
    [{ file: 'packages/kernel/index.js', names: ['three'] }]);
});
