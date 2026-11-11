/** @pullboard-test-input source-tree */
/** Real committed Kernel contracts and authenticated decision approvals [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { kernelGateChange } from '../../../../packages/verify/index.js';
import { kernelApprovalText } from '../../../../packages/verify/index.js';
import { requireKernelApproval } from '../../../../packages/verify/index.js';
import { openBoard } from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';

/** Seed a real public door, its private body and a tiny real gate under accepted ownership. */
function fixture(t, gate = 'true') {
  const box = privateRepo(t);
  const config = { gate, affectedTests: 'node --test', spec: 'SPEC.md', view: { background: false } };
  put(box.root, 'pullboard.json', JSON.stringify(config));
  put(box.root, 'packages/kernel/index.js', "export { one } from './src/logic/value.js';\n");
  put(box.root, 'packages/kernel/light.js', "export { one } from './src/logic/value.js';\n");
  put(box.root, 'packages/kernel/src/logic/value.js', 'export const one = 1;\nexport const two = 2;\n');
  const mainRoot = box.root;
  const build = builderRepo(box, ['packages/kernel/']);
  const made = build.coordinator('add', 'build', 'A Kernel contract fixture', '--criterion', 'The requested contract is implemented', '--check', 'true', '--json');
  assert.equal(made.code, 0, made.err);
  const claim = build.run('claim', '1');
  assert.equal(claim.code, 0, claim.err);
  return { ...build, mainRoot, base: build.git('rev-parse', 'HEAD') };
}

/** Open only this fixture's genuine shared board; normal operations provide all writes. */
function boardFor(box, action) {
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.mainRoot, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Exercise the existing decision writer, including its authenticated person-origin branch. */
function answer(box, text, person = true) {
  return boardFor(box, board => {
    const lanes = ['coordinator', 'build'];
    const ask = store.shout(board, { from: 'coordinator', to: person ? 'person' : 'build', text: 'Approve the exact Kernel contract?', decision: true, lanes });
    return store.answerDecision(board, ask, { agentId: person ? 'coordinator' : store.agentAt(board, box.root).agent_id,
      text, lanes, asPerson: person, channel: 'view' });
  });
}

/** Require the guard's refusal, including its real changed-export diagnostics. */
function refused(box, commit, names) {
  assert.throws(() => boardFor(box, board => requireKernelApproval(board, { root: box.root, base: box.base, commit, item: 1 })), error => {
    assert.equal(error.code, 'KERNEL_EXPORT_APPROVAL');
    for (const name of names) assert.ok(error.message.includes(name), error.message);
    return true;
  });
}

test('submit refuses a changed Kernel door and names exports before any test gate [C7]', t => {
  const box = fixture(t);
  put(box.root, 'packages/kernel/index.js', "export { one, two } from './src/logic/value.js';\n");
  const commit = commitAll(box, 'feat(kernel): expose two [G1]');
  const change = kernelGateChange(box.root, box.base, commit);
  assert.deepEqual(change.changes, [{ file: 'packages/kernel/index.js', names: ['two'] }]);
  const result = box.run('submit', '1', '--no-next', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'KERNEL_EXPORT_APPROVAL');
  assert.match(result.out, /two/u);
  boardFor(box, board => assert.equal(store.getItem(board, 1).item_status, 'claimed'));
});

test('an internal Kernel behavior change reaches normal submit without person consent [C7]', t => {
  const box = fixture(t);
  put(box.root, 'packages/kernel/src/logic/value.js', 'export const one = 3;\nexport const two = 2;\n');
  const commit = commitAll(box, 'fix(kernel): adjust private behavior [G1]');
  assert.equal(kernelGateChange(box.root, box.base, commit), null);
  const result = box.run('submit', '1', '--no-next', '--json');
  assert.equal(result.code, 0, result.out + result.err);
  boardFor(box, board => assert.equal(store.getItem(board, 1).item_status, 'submitted'));
});

test('only the person can approve the exact item and Kernel interface for submit [C7]', t => {
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
  const result = box.run('submit', '1', '--no-next', '--json');
  assert.equal(result.code, 0, result.out + result.err);
  boardFor(box, board => assert.equal(store.getItem(board, 1).item_status, 'submitted'));
});

test('person consent cannot carry to another export contract and a later decline revokes it [C7]', t => {
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

test('star-forwarded public names are checked while private body changes preserve approval scope [C7]', t => {
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


test('submit rechecks a person decline recorded while the real gate runs [C7]', t => {
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
  const result = box.run('submit', '1', '--no-next', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'KERNEL_EXPORT_APPROVAL');
  boardFor(box, board => {
    assert.equal(store.getItem(board, 1).item_status, 'claimed');
    assert.ok(store.events(board).some(event => event.event_kind === 'answer'
      && event.event_by === 'person' && JSON.parse(event.event_detail).shout));
  });
});
