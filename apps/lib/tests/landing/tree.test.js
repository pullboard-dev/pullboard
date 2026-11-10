/** A landing whose merged tree is exactly the item's green gated tree reuses that gate instead of rerunning [C7,#2902]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../../packages/jobs/index.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { landingProof } from '../../../../packages/landing/index.js';
import { provenTreeGate } from '../../../../packages/landing/index.js';
import { quickGuards } from '../../../../packages/landing/index.js';

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

test('the item\'s green gate on exactly this merged tree is the landing proof, with no rerun [C7,#2902]', t => {
  const { board, id } = fixture(t);
  const proven = provenTreeGate(board, [{ id, commit: COMMIT }], TREE);
  assert.deepEqual(proven, { isGreen: true, tree: TREE, failures: [], logPath: null, reusedSubmitGate: 'job-1' });
});

test('a different tree, commit, bar, gate state or a multi-item batch runs the plan as before [C7,#2902]', t => {
  const { board, id } = fixture(t);
  assert.equal(provenTreeGate(board, [{ id, commit: COMMIT }], 'u'.repeat(40)), null, 'main moved, so the merged tree differs');
  assert.equal(provenTreeGate(board, [{ id, commit: 'd'.repeat(40) }], TREE), null, 'another head');
  assert.equal(provenTreeGate(board, [{ id, commit: COMMIT }, { id: id + 1, commit: COMMIT }], TREE), null, 'two items');
  const red = fixture(t, { state: 'red' });
  assert.equal(provenTreeGate(red.board, [{ id: red.id, commit: COMMIT }], TREE), null, 'a red gate proves nothing');
  const rebarred = fixture(t, { digest: 'old-digest' });
  assert.equal(provenTreeGate(rebarred.board, [{ id: rebarred.id, commit: COMMIT }], TREE), null, 'a changed bar needs its own run');
});

test('the landing proof keeps the reused submit receipt id, and a fresh gate run records none [C7,#2902]', t => {
  const { board, id } = fixture(t);
  const reused = provenTreeGate(board, [{ id, commit: COMMIT }], TREE);
  assert.deepEqual(landingProof(reused, () => assert.fail('a green reuse needs no waiver')),
    { tree: TREE, failures: [], logPath: null, reusedSubmitGate: 'job-1' });
  assert.deepEqual(landingProof({ isGreen: true, tree: 'u'.repeat(40), logPath: '/log' }, () => null),
    { tree: 'u'.repeat(40), failures: [], logPath: '/log' }, 'a changed tree ran its own gate, so no receipt is reused');
  assert.equal(landingProof({ isGreen: false }, () => 'waived'), 'waived');
});

/** A real git repo with one commit; its tree is the merged tree a landing would gate. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'reuse-tree-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  run('init', '-q'); writeFileSync(join(root, 'a.txt'), 'a\n'); run('add', '.');
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
  return { root, tree: run('rev-parse', 'HEAD^{tree}'), commit: run('rev-parse', 'HEAD') };
}

/** The landing state quickGuards reads, with its gate, static check and smoke replaced by recorders. */
function landing(board, id, git) {
  const calls = { gate: 0, checks: 0, smoke: 0 };
  const state = { board, root: git.root, config: {}, say() {}, batch: { root: git.root, items: [{ id, commit: git.commit }] },
    guardServices: {
      gateGroup: async () => { calls.gate += 1; return { isGreen: true, tree: git.tree, failures: [], logPath: '/fresh.log' }; },
      runStaticChecks: async () => { calls.checks += 1; return {}; },
      runLandingCliSmoke: () => { calls.smoke += 1; } } };
  return { state, calls };
}

test('clause 1: a landing whose merged tree equals the submit gate tree skips gateGroup and records the reused receipt [C7,#2902]', async t => {
  const git = repo(t);
  const { board, id } = fixture(t, { executionTree: git.tree, commit: git.commit });
  const { state, calls } = landing(board, id, git);
  const gate = await quickGuards(state);
  assert.equal(calls.gate, 0, 'no tests run');
  assert.equal(calls.checks, 1, 'the static checks still run');
  assert.equal(calls.smoke, 1, 'the CLI smoke still runs');
  assert.deepEqual(landingProof(gate, () => assert.fail('green needs no waiver')),
    { tree: git.tree, failures: [], logPath: null, reusedSubmitGate: 'job-1' });
});

test('clause 2: a merged tree the submit gate never proved runs the item\'s plan through gateGroup [C7,#2902]', async t => {
  const git = repo(t);
  const { board, id } = fixture(t, { executionTree: 'u'.repeat(40), commit: git.commit });
  const { state, calls } = landing(board, id, git);
  const gate = await quickGuards(state);
  assert.equal(calls.gate, 1, 'the gate ran on the different tree');
  assert.equal(landingProof(gate, () => null).reusedSubmitGate, undefined, 'the fresh run records no reused receipt');
  assert.equal(landingProof(gate, () => null).logPath, '/fresh.log');
});
