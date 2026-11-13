/** @pullboard-test-input apps/lib/src/logic/native.js packages/kernel/index.js packages/kernel/light.js packages/store/index.js */
/** A person decline recorded while the pulled gate runs sends the Kernel change back to its builder [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { kernelGateChange } from '../../../../../packages/verify/index.js';
import { kernelApprovalText } from '../../../../../packages/verify/index.js';
import * as store from '../../../../../packages/store/index.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { put } from '../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { fixture } from '../../../tests/fixtures/submit/kernel.js';
import { settleBox } from '../../../tests/fixtures/submit/kernel.js';
import { boardFor } from '../../../tests/fixtures/submit/kernel.js';
import { answer } from '../../../tests/fixtures/submit/kernel.js';

test('submit rechecks a person decline recorded while the real gate runs [C7]', async t => {
  const source = [
    `import { openBoard } from ${JSON.stringify(new URL('../../../lib/src/logic/native.js', import.meta.url).href)};`,
    `import * as store from ${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)};`,
    "const board = openBoard(process.env.KERNEL_BOARD, undefined, { isMain: true });",
    "try { const lanes = ['coordinator', 'build'];",
    "const ask = store.shout(board, { from: 'coordinator', to: 'person', text: 'Reconsider the Kernel contract', decision: true, lanes });",
    "store.answerDecision(board, ask, { agentId: 'coordinator', text: process.env.KERNEL_DECLINE, lanes, asPerson: true, channel: 'view' });",
    "} finally { store.closeBoard(board); }",
  ].join('\n');
  const command = "node --input-type=module -e '" + source.replaceAll("'", "'\\''") + "'";
  const box = fixture(t, command);
  put(box.root, 'packages/kernel/index.js', "export { one, two } from './src/logic/value.js';\n");
  const commit = commitAll(box, 'feat(kernel): expose two before reconsideration [G1]');
  const change = kernelGateChange(box.root, box.base, commit);
  answer(box, kernelApprovalText(1, change.digest));
  box.env.KERNEL_BOARD = join(box.mainRoot, '.git/pullboard/board.sqlite');
  box.env.KERNEL_DECLINE = kernelApprovalText(1, change.digest, false);
  const result = await runCliInProcess(['submit', '1', '--no-next', '--json'], { cwd: box.root, env: box.env });
  assert.equal(result.code, 0, result.out + result.err);
  await settleSubmit(t, settleBox(box), JSON.parse(result.out));
  boardFor(box, board => {
    assert.equal(store.getItem(board, 1).item_status, 'claimed', 'the decline recorded while the gate ran sends the item back to its builder');
    assert.ok(store.events(board).some(event => event.event_kind === 'answer'
      && event.event_by === 'person' && JSON.parse(event.event_detail).shout));
  });
});
