/** @pullboard-test-input apps/lib/src/logic/native.js packages/kernel/index.js packages/kernel/light.js packages/store/index.js */
/** An internal Kernel behavior change reaches the pulled submit gate with no person consent [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { kernelGateChange } from '../../../../../packages/verify/index.js';
import * as store from '../../../../../packages/store/index.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { put } from '../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { fixture } from '../../../tests/fixtures/submit/kernel.js';
import { settleBox } from '../../../tests/fixtures/submit/kernel.js';
import { boardFor } from '../../../tests/fixtures/submit/kernel.js';

test('an internal Kernel behavior change reaches normal submit without person consent [C7]', async t => {
  const box = fixture(t);
  put(box.root, 'packages/kernel/src/logic/value.js', 'export const one = 3;\nexport const two = 2;\n');
  const commit = commitAll(box, 'fix(kernel): adjust private behavior [G1]');
  assert.equal(kernelGateChange(box.root, box.base, commit), null);
  const result = await runCliInProcess(['submit', '1', '--no-next', '--json'], { cwd: box.root, env: box.env });
  assert.equal(result.code, 0, result.out + result.err);
  await settleSubmit(t, settleBox(box), JSON.parse(result.out));
  boardFor(box, board => assert.equal(store.getItem(board, 1).item_status, 'submitted'));
});
