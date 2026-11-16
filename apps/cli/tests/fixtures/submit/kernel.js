/** The shared Kernel contract fixture: a real public door, its private body and approvals through the real board [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openBoard } from '../../../../lib/index.js';
import * as store from '../../../../../packages/store/index.js';
import { privateRepo } from './gate.js';
import { builderRepo } from './gate.js';
import { put } from './gate.js';

/** Seed a real public door, its private body and a tiny real gate under accepted ownership. */
export function fixture(t, gate = 'true') {
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

/** The box the pulled-gate settle helper reads: the fixture's builder checkout is its repo, and its run takes no folder [P7,#6249]. */
export function settleBox(box) {
  return { env: box.env, repo: box.root, run: (_cwd, ...args) => box.run(...args) };
}

/** Open only this fixture's genuine shared board; normal operations provide all writes. */
export function boardFor(box, action) {
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.mainRoot, '.git/pullboard/board.sqlite'), undefined, { isMain: true });
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Exercise the existing decision writer, including its authenticated person-origin branch. */
export function answer(box, text, person = true) {
  return boardFor(box, board => {
    const lanes = ['coordinator', 'build'];
    const ask = store.shout(board, { from: 'coordinator', to: person ? 'person' : 'build', text: 'Approve the exact Kernel contract?', decision: true, lanes });
    return store.answerDecision(board, ask, { agentId: person ? 'coordinator' : store.agentAt(board, box.root).agent_id,
      text, lanes, asPerson: person, channel: 'view' });
  });
}
