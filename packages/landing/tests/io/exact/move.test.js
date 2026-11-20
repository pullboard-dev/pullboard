/** Main moves by compare-and-set from the staged base: a moved main restages the batch up to 3 times, then the items yield: RFC 0011 ET3, approved 17 Nov 2026 [V16,V35]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { RESTAGE_LIMIT } from '../../../src/io/exact.js';
import { stageUntilCurrent } from '../../../src/io/exact.js';
import { retryableLandingRefusal } from '../../../src/logic/retry.js';
import { moveTrunkRef } from '../../../src/io/step/publish.js';
import { settleOnMain } from '../../../src/io/step/publish.js';
import { candidates } from '../../../src/io/step/selection.js';
import { save } from '../../../src/io/step/merge.js';
import * as store from '../../../../store/index.js';
import { validateLandingBatch } from '../../../../items/index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';

/** A real repository: main at a base, an item tip above it checked out in a second worktree, and `advance` to land one more commit on main. */
function repository(t) {
  const { root, put } = fixture(t);
  put('packages/alpha/src/a.js', 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put('packages/alpha/src/a.js', 'export const a = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feat: item 7');
  const tip = git(root, 'rev-parse', 'HEAD').trim();
  const batchRoot = `${root}-batch`;
  git(root, 'worktree', 'add', '-q', '--detach', batchRoot, tip);
  t.after(() => rmSync(batchRoot, { recursive: true, force: true }));
  git(root, 'reset', '-q', '--hard', base);
  let moves = 0;
  /** Another landing: one more commit on main, in a file the batch does not touch. */
  const advance = () => {
    put(`docs/other-${++moves}.md`, `other landing ${moves}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `docs: other landing ${moves}`);
    return git(root, 'rev-parse', 'HEAD').trim();
  };
  return { root, batchRoot, base, tip, advance, put, main: () => git(root, 'rev-parse', 'refs/heads/main').trim() };
}

/** A landing state on a real repository and board: its write validates and numbers each batch revision. */
async function landingState(t, { root, batchRoot, base, tip }, sprintPorts) {
  const batch = { version: 1, id: 'batch-7', state: 'trunk', base, tip, root: batchRoot, branch: 'refs/heads/main',
    items: [{ id: 7, commit: tip }], owner: 'coordinator', logPath: '/dev/null', conflicts: [], resolutions: [], revision: 0 };
  const said = [];
  const write = async (name, [{ batch: next, revision }]) => {
    assert.equal(name, 'recordLandingBatch');
    validateLandingBatch(next, revision);
    return { ...next, revision: revision + 1 };
  };
  const state = { root, batch, config: {}, write, say: line => said.push(line), checkLease: async () => {}, sprintPorts, board: fixtureBoard(t) };
  await save(state, {});
  return { state, said };
}

/** Sprint runners that are green and count the proofs run; `onProof` runs inside each one. */
function proofs(root, { onProof = () => {} } = {}) {
  const ran = [];
  return { ran, ports: {
    changedFiles: () => git(root, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean),
    pin: () => 'tooling-pin',
    runStatic: async () => { ran.push('static'); onProof(); return { isGreen: true }; },
    runCell: async cell => { ran.push(cell); return { isGreen: true }; },
  } };
}

test('landing.exact.move-restages-on-a-moved-main: clause 1: a main that moved since staging restages the batch on the new tip, proves the new exact tree again and then the compare-and-set moves main [V16,V35]', async t => {
  const repo = repository(t);
  const moved = repo.advance();
  const { ran, ports } = proofs(repo.batchRoot);
  const { state } = await landingState(t, repo, ports);
  const settled = await settleOnMain(state);
  assert.deepEqual(settled, { restages: 1, yielded: false });
  assert.equal(state.batch.base, moved, 'the batch is staged on the new main');
  assert.equal(git(repo.root, 'rev-parse', `${state.batch.tip}^1`).trim(), moved, 'the new tip sits on the new main');
  assert.equal(git(repo.root, 'rev-parse', `${state.batch.tip}^2`).trim(), repo.tip, 'and carries the old tip, so the item merges stay in history');
  assert.equal(state.batch.exactTree.tree, git(repo.root, 'rev-parse', `${state.batch.tip}^{tree}`).trim(), 'the proof names the tree of the restaged tip');
  assert.equal(state.batch.exactTree.result, 'green');
  assert.deepEqual(ran, ['static', 'packages/alpha'], 'the Sprint proof ran once more, on the restaged tree');
  assert.equal(repo.main(), moved, 'restaging does not move main');
  await moveTrunkRef(state);
  assert.equal(repo.main(), state.batch.tip, 'the compare-and-set from the restaged base moves main');
  assert.equal(git(repo.root, 'show', 'HEAD:packages/alpha/src/a.js').trim(), 'export const a = 2;', 'main holds the item');
  assert.match(git(repo.root, 'show', 'HEAD:docs/other-1.md'), /other landing 1/u, 'and the landing that moved main first');
});

test('landing.exact.move-yields-after-three-restages: clause 2: after 3 restages without a successful compare-and-set the batch is recorded yielded and its items go back to the queue behind the others [V16,V35]', async t => {
  const repo = repository(t);
  repo.advance();
  const { ran, ports } = proofs(repo.batchRoot, { onProof: () => repo.advance() });
  const { state } = await landingState(t, repo, ports);
  await assert.rejects(() => settleOnMain(state), error => error.code === 'LAND_YIELDED' && /yield/u.test(error.message));
  assert.equal(ran.filter(name => name === 'static').length, RESTAGE_LIMIT, 'each restage was proved again, 3 in all');
  assert.equal(state.batch.state, 'blocked');
  assert.equal(state.batch.refusal.code, 'LAND_YIELDED');
  assert.equal(state.batch.yielded.restages, RESTAGE_LIMIT);
  assert.notEqual(repo.main(), state.batch.tip, 'main was never moved by the yielded batch');
  assert.ok(store.stepAsideCount(state.board, 7) >= 2, 'the item has stepped aside');
  assert.equal(retryableLandingRefusal('LAND_YIELDED'), true, 'a new main retires the yielded block');
  for (const id of [7, 8]) state.board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-17T00:00:00.000Z', 'fixture', 'accept', ?, '{}')").run(id);
  const listed = [7, 8].map(id => ({ item_id: id, item_status: 'verified', item_merged_commit: null, item_commit: repo.base, item_hold_at: null }));
  const order = candidates(state.board, repo.root, repo.base, 8, { listItems: () => listed, stepAside: 2 }).ready.map(item => item.item_id);
  assert.deepEqual(order, [8, 7], 'the yielded item lands behind the item that did not yield');
  assert.equal(RESTAGE_LIMIT, 3);
  const calls = [];
  const result = await stageUntilCurrent({ verify: async () => { calls.push('verify'); throw Object.assign(new Error('moved'), { code: 'LAND_MAIN_MOVED' }); },
    restage: async () => { calls.push('restage'); }, prove: async () => { calls.push('prove'); }, yieldTurn: async () => { calls.push('yield'); } }, 1);
  assert.deepEqual(result, { restages: 1, yielded: true });
  assert.deepEqual(calls, ['verify', 'restage', 'prove', 'verify', 'yield'], 'the loop restages, proves, checks again and yields');
});
