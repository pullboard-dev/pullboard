/** A red file in the Sprint proof reruns once on the same tree against main's receipt before the landing is refused: RFC 0011 ET6 at Sprint, narrowed and approved 17 Nov 2026 [V16,V37]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { sprintProof } from '../../../src/io/exact.js';
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

/** Sprint runners where `packages/alpha` runs red in `files`; `rerun` says whether each rerun of a file is green and `receipts` is main's receipt per file. */
function runners(root, base, tip, { files = ['packages/alpha/tests/a.test.js'], rerun = {}, receipts = {} } = {}) {
  const calls = [];
  const ports = {
    changedFiles: () => git(root, 'diff', '--name-only', base, tip).split('\n').filter(Boolean),
    pin: () => 'tooling-pin',
    runStatic: async () => { calls.push('static'); return { isGreen: true }; },
    runCell: async cell => { calls.push(cell); return cell === 'packages/alpha' ? { isGreen: false, output: 'not ok', files } : { isGreen: true }; },
    rerunFile: async file => { calls.push(`rerun ${file}`); return { isGreen: rerun[file] !== false }; },
    mainReceipt: file => receipts[file] ?? null,
  };
  return { ports, calls };
}

const GREEN = { result: 'green', main: 'f'.repeat(40), receiptId: 'job-1' };

test('landing.exact.flake-rerun-goes-on-when-main-green: clause 1: a red file that is green on its single rerun on the same tree, with a green main receipt for it, lets the landing go on and records a flake naming the file and tree [V16,V37]', async t => {
  const repo = repository(t);
  const { root, base, tip, treeOf } = repo;
  const file = 'packages/alpha/tests/a.test.js';
  const { ports, calls } = runners(root, base, tip, { receipts: { [file]: GREEN } });
  const { state } = await landingState(repo, ports);
  const record = await requireSprintProof(state);
  assert.equal(record.result, 'green');
  assert.deepEqual(record.flakes, [{ file, tree: treeOf(tip) }], 'the flake observation names the file and the tree');
  assert.deepEqual(calls, ['static', 'apps/beta', 'packages/alpha', `rerun ${file}`], 'the file reran once, and the proof went on');
  assert.deepEqual(state.batch.exactTree.flakes, record.flakes, 'the observation is on the saved batch record');
});

test('landing.exact.flake-rerun-refuses-red-again: clause 2: a file red again on its rerun, or one main has no green receipt for, refuses the landing naming the file, the tree id and main\'s receipt or its absence [V16,V37]', async t => {
  const repo = repository(t);
  const { root, base, tip, treeOf } = repo;
  const file = 'packages/alpha/tests/a.test.js';
  const cases = [
    { name: 'red again', options: { rerun: { [file]: false }, receipts: { [file]: GREEN } }, detail: /red again on its rerun/u },
    { name: 'no main receipt', options: {}, detail: /green on its rerun; main has no receipt for it/u },
    { name: 'main red', options: { receipts: { [file]: { result: 'red', main: 'e'.repeat(40) } } }, detail: /main's receipt for it is red at eeeeeeeeeeee/u },
  ];
  for (const { name, options, detail } of cases) {
    const { ports, calls } = runners(root, base, tip, options);
    const { state } = await landingState(repo, ports);
    await assert.rejects(() => requireSprintProof(state), error => error.code === 'LAND_EXACT_RED'
      && error.message.includes(file) && error.message.includes(treeOf(tip)) && detail.test(error.message), name);
    assert.equal(state.batch.exactTree.result, 'red', name);
    assert.equal(state.batch.exactTree.file, file, name);
    assert.equal(calls.filter(call => call.startsWith('rerun')).length, 1, `${name}: the file reran once, not again`);
  }
});

test('landing.exact.flake-rerun-needs-every-file: clause 2: with two red files, one flaky with a green main receipt and one without, the proof is red naming the second file [V16,V37]', async () => {
  const files = ['packages/alpha/tests/a.test.js', 'packages/alpha/tests/b.test.js'];
  const ports = { changedFiles: () => ['packages/alpha/src/a.js'], pin: () => 'pin', runStatic: async () => ({ isGreen: true }),
    runCell: async () => ({ isGreen: false, files }), rerunFile: async () => ({ isGreen: true }), mainReceipt: file => (file === files[0] ? GREEN : null) };
  const proof = await sprintProof({ tree: 'a'.repeat(40) }, ports);
  assert.equal(proof.result, 'red');
  assert.equal(proof.file, files[1]);
  assert.deepEqual(proof.flakes, [{ file: files[0], tree: 'a'.repeat(40) }], 'the first file stays recorded as a flake');
});

test('landing.exact-flake.awaits-main-receipt: clause 1: sprintProof awaits a mainReceipt port that returns a promise: a green receipt settles a flake, a non-green or missing receipt refuses, a direct value behaves as before [C7]', async () => {
  const file = 'packages/alpha/tests/a.test.js';
  const prove = receipt => sprintProof({ tree: 'a'.repeat(40) }, {
    changedFiles: () => ['packages/alpha/src/a.js'],
    pin: () => 'tooling-pin',
    runStatic: async () => ({ isGreen: true }),
    runCell: async () => ({ isGreen: false, output: 'not ok', files: [file] }),
    rerunFile: async () => ({ isGreen: true }),
    mainReceipt: receipt,
  });
  const settled = await prove(async () => GREEN);
  assert.equal(settled.result, 'green');
  assert.deepEqual(settled.flakes, [{ file, tree: 'a'.repeat(40) }]);
  assert.equal((await prove(async () => ({ ...GREEN, result: 'red' }))).result, 'red');
  assert.equal((await prove(async () => null)).result, 'red');
  assert.equal((await prove(() => GREEN)).result, 'green', 'a port that returns the receipt directly behaves as before');
  assert.equal((await prove(() => null)).result, 'red');
});
