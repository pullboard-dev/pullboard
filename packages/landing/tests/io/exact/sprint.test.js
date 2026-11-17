/** The Sprint proof runs on the exact tree before main moves: RFC 0011 ET6 at Sprint, narrowed and approved 17 Nov 2026 [V16,V37]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { changedCells } from '../../../src/io/exact.js';
import { finishTrunk } from '../../../src/io/step/publish.js';
import { requireSprintProof } from '../../../src/io/step/publish.js';
import { save } from '../../../src/io/step/merge.js';
import { validateLandingBatch } from '../../../../items/index.js';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';

/** A real repository: main at a base commit, and a tip commit above it that changes one file in each of two cells. */
function repository(t) {
  const { root, put } = fixture(t);
  put('packages/alpha/src/a.js', 'export const a = 1;\n');
  put('apps/beta/b.js', 'export const b = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put('packages/alpha/src/a.js', 'export const a = 2;\n');
  put('apps/beta/b.js', 'export const b = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feat: item 7');
  const tip = git(root, 'rev-parse', 'HEAD').trim();
  // The batch root is a second checkout of the tip, as in a landing; the primary checkout goes back to main at the base, so main has not moved.
  const batchRoot = `${root}-batch`;
  git(root, 'worktree', 'add', '-q', '--detach', batchRoot, tip);
  t.after(() => rmSync(batchRoot, { recursive: true, force: true }));
  git(root, 'reset', '-q', '--hard', base);
  const treeOf = commit => git(root, 'rev-parse', `${commit}^{tree}`).trim();
  return { root, batchRoot, base, tip, treeOf, main: () => git(root, 'rev-parse', 'refs/heads/main').trim() };
}

/** A landing state on a real repository: its board write validates and numbers each batch revision, and it counts the writes by name. */
async function landingState({ root, batchRoot, base, tip }, ports) {
  const batch = { version: 1, id: 'batch-7', state: 'gating', base, tip, root: batchRoot, branch: 'refs/heads/main',
    items: [], owner: 'coordinator', logPath: '/dev/null', conflicts: [], resolutions: [], revision: 0 };
  const writes = [];
  const said = [];
  const write = async (name, [{ batch: next, revision }]) => {
    writes.push(name);
    if (name === 'recordLandingBatch') {
      validateLandingBatch(next, revision);
      return { ...next, revision: revision + 1 };
    }
    return { ...batch, ...state.batch, state: 'finished' };
  };
  const state = { root, batch, config: {}, write, say: line => said.push(line), checkLease: async () => {}, sprintPorts: ports,
    board: { clock: { now: () => new Date('2026-11-17T20:00:00.000Z') } }, landingPorts: { validateQuarantineLandingProof() {} } };
  await save(state, { state: 'gating' });
  return { state, writes, said };
}

/** Fake runners that record what ran and in what order; a cell named in `red` runs red. */
function runners(root, base, tip, { red = [], staticRed = false } = {}) {
  const calls = [];
  const ports = {
    changedFiles: () => git(root, 'diff', '--name-only', base, tip).split('\n').filter(Boolean),
    pin: () => 'tooling-pin-0123456789abcdef0123456789abcdef0123',
    runStatic: async () => { calls.push('static'); return { isGreen: !staticRed, output: staticRed ? 'src/a.js:1: bad rule' : '' }; },
    runCell: async cell => { calls.push(cell); return { isGreen: !red.includes(cell), output: red.includes(cell) ? `not ok in ${cell}` : '' }; },
  };
  return { ports, calls };
}

test('landing.exact.sprint-records-pin-cells-result: clause 1: the lander runs the static stage then the tests of each changed cell on the composed tip and records exactTree.pin, cells and result with exactTree.tree equal to that tip tree [V16,V37]', async t => {
  const repo = repository(t);
  const { root, base, tip, treeOf } = repo;
  const { ports, calls } = runners(root, base, tip);
  const { state } = await landingState(repo, ports);
  const record = await requireSprintProof(state);
  assert.deepEqual(calls, ['static', 'apps/beta', 'packages/alpha'], 'static first, then each changed cell once, sorted');
  assert.deepEqual(state.batch.exactTree, { tree: treeOf(tip), pin: 'tooling-pin-0123456789abcdef0123456789abcdef0123', cells: ['apps/beta', 'packages/alpha'], result: 'green' });
  assert.equal(record.tree, treeOf(tip), 'the proof is keyed by the tree id of the tip main will point to');
  assert.deepEqual(changedCells(['packages/alpha/src/a.js', 'packages/alpha/tests/a.test.js', 'apps/beta/b.js', 'README.md']), ['apps/beta', 'packages/alpha']);
  const again = runners(root, base, tip);
  state.sprintPorts = again.ports;
  assert.equal((await requireSprintProof(state)).result, 'green');
  assert.deepEqual(again.calls, [], 'an adopted batch holding a green proof for this tree runs nothing again');
});

test('landing.exact.sprint-red-leaves-main: clause 2: a red cell in the proof leaves main where it was and records the batch blocked with the failing cell named [V16,V37]', async t => {
  const repo = repository(t);
  const { root, base, tip, main } = repo;
  for (const red of [['packages/alpha'], ['apps/beta', 'packages/alpha']]) {
    const { ports, calls } = runners(root, base, tip, { red });
    const { state, writes, said } = await landingState(repo, ports);
    await assert.rejects(() => finishTrunk(state), error => error.code === 'LAND_EXACT_RED' && /apps\/beta|packages\/alpha/u.test(error.message));
    assert.equal(main(), base, 'main did not move');
    assert.equal(state.batch.state, 'blocked');
    assert.equal(state.batch.refusal.code, 'LAND_EXACT_RED');
    assert.equal(state.batch.exactTree.result, 'red');
    assert.equal(state.batch.exactTree.failed, red[0], 'the first red cell in sorted order is named');
    assert.match(state.batch.refusal.message, new RegExp(red[0]));
    assert.equal(writes.includes('finishLandingBatch'), false, 'no main-moved receipt is recorded for a red tree');
    assert.equal(calls.at(-1), red[0], 'the proof stops at the first red cell');
    assert.ok(said.some(line => line.includes('Sprint proof is red')));
  }
  const failed = runners(root, base, tip, { staticRed: true });
  const { state } = await landingState(repo, failed.ports);
  await assert.rejects(() => requireSprintProof(state), error => error.code === 'LAND_EXACT_RED' && /static/u.test(error.message));
  assert.equal(state.batch.exactTree.failed, 'static');
  assert.deepEqual(failed.calls, ['static'], 'a red static stage runs no cell');
  assert.equal(main(), base);
});
