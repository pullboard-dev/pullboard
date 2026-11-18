/** A landing whose merged tree is exactly the item's green gated tree reuses that gate instead of rerunning [C7,#2902]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordSubmitHandoff } from '../../../../packages/jobs/index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { landingProof } from '../../../../packages/landing/index.js';
import { provenTreeGate } from '../../../../packages/landing/index.js';

const TREE = 't'.repeat(40);
const COMMIT = 'c'.repeat(40);

/** A board with one item whose submit gate went green on TREE at COMMIT under its frozen bar. */
function fixture(t, job = {}) {
  const board = openBoard(':memory:', { now: () => new Date('2026-11-04T08:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Reuse a proven tree' });
  board.db.prepare('UPDATE item SET item_frozen_digest = ? WHERE item_id = ?').run('digest', id);
  recordSubmitHandoff(board.db, id, { version: 1, id: 'job-1', agentId: 'core-1', commit: COMMIT, executionTree: TREE, digest: 'digest', state: 'green', gateGreen: true, ...job });
  return { board, id };
}

test('lib.landing-tree.the-item-s-green-gate-on: the item\'s green gate on exactly this merged tree is the landing proof, with no rerun [C7,#2902]', t => {
  const { board, id } = fixture(t);
  const proven = provenTreeGate(board, [{ id, commit: COMMIT }], TREE);
  assert.deepEqual(proven, { isGreen: true, tree: TREE, failures: [], logPath: null, reusedSubmitGate: 'job-1' });
});

test('lib.landing-tree.a-different-tree-commit-bar-gate: a different tree, commit, bar, gate state or a multi-item batch runs the plan as before [C7,#2902]', t => {
  const { board, id } = fixture(t);
  assert.equal(provenTreeGate(board, [{ id, commit: COMMIT }], 'u'.repeat(40)), null, 'main moved, so the merged tree differs');
  assert.equal(provenTreeGate(board, [{ id, commit: 'd'.repeat(40) }], TREE), null, 'another head');
  assert.equal(provenTreeGate(board, [{ id, commit: COMMIT }, { id: id + 1, commit: COMMIT }], TREE), null, 'two items');
  const red = fixture(t, { state: 'red' });
  assert.equal(provenTreeGate(red.board, [{ id: red.id, commit: COMMIT }], TREE), null, 'a red gate proves nothing');
  const rebarred = fixture(t, { digest: 'old-digest' });
  assert.equal(provenTreeGate(rebarred.board, [{ id: rebarred.id, commit: COMMIT }], TREE), null, 'a changed bar needs its own run');
});

test('lib.landing-tree.the-landing-proof-keeps-the-reused: the landing proof keeps the reused submit receipt id, and a fresh gate run records none [C7,#2902]', t => {
  const { board, id } = fixture(t);
  const reused = provenTreeGate(board, [{ id, commit: COMMIT }], TREE);
  assert.deepEqual(landingProof(reused, () => assert.fail('a green reuse needs no waiver')),
    { tree: TREE, failures: [], logPath: null, reusedSubmitGate: 'job-1' });
  assert.deepEqual(landingProof({ isGreen: true, tree: 'u'.repeat(40), logPath: '/log' }, () => null),
    { tree: 'u'.repeat(40), failures: [], logPath: '/log' }, 'a changed tree ran its own gate, so no receipt is reused');
  assert.equal(landingProof({ isGreen: false }, () => 'waived'), 'waived');
});

test('lib.landing-tree.clauses-1-2-the-trunk-move: #6816 clauses 1-2: the trunk-move guards are gone from step/trunk.js and named nowhere in the tree [C7,#6816]', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  // The names are split so this test does not name them; git grep exits 1 when nothing matches.
  for (const name of ['followMoved' + 'Trunk', 'reusedAcross' + 'Move', 'quick' + 'Guards']) {
    let named = '';
    try { named = execFileSync('git', ['grep', '-l', '-w', '-F', name], { cwd: root, encoding: 'utf8' }); }
    catch (error) { if (error.status !== 1) throw error; }
    assert.equal(named, '', name);
  }
});
