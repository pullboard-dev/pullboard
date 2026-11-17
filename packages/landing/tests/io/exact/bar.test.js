/** With landing.sprintBarTests on, the Sprint proof runs every batch item's frozen bar tests on the exact staged tree: U147 correction (a) of the 17 Nov 2026 ruling [C7,V16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { barTestPort } from '../../../src/io/step/gate.js';
import { sprintPorts } from '../../../src/io/step/gate.js';
import { requireSprintProof } from '../../../src/io/step/publish.js';
import { save } from '../../../src/io/step/merge.js';
import { validateLandingBatch } from '../../../../items/index.js';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';

const ALPHA = 'packages/alpha/tests/a.test.js';
const BETA = 'packages/beta/tests/b.test.js';
const PIN = 'tooling-pin-0123456789abcdef0123456789abcdef0123';

/** A real repository: main at a base, and a tip that changes one source file and adds two test files, one named by each of two items' frozen bars. */
function repository(t) {
  const { root, put } = fixture(t);
  put('packages/alpha/src/a.js', 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put('packages/alpha/src/a.js', 'export const a = 2;\n');
  put(ALPHA, "import { test } from 'node:test';\ntest('a', () => {});\n");
  put(BETA, "import { test } from 'node:test';\ntest('b', () => {});\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feat: items 7 and 8');
  const tip = git(root, 'rev-parse', 'HEAD').trim();
  const batchRoot = `${root}-batch`;
  git(root, 'worktree', 'add', '-q', '--detach', batchRoot, tip);
  t.after(() => rmSync(batchRoot, { recursive: true, force: true }));
  git(root, 'reset', '-q', '--hard', base);
  const treeOf = commit => git(root, 'rev-parse', `${commit}^{tree}`).trim();
  return { root, batchRoot, base, tip, treeOf, main: () => git(root, 'rev-parse', 'refs/heads/main').trim() };
}

/** One item's board row with the check frozen at its claim: the criterion digest binds it to the submitted commit. */
function frozenItem(commit, file) {
  const item_frozen = JSON.stringify({ check: `node packages/gate/src/io/run/tests.js ${file}` });
  return { item_commit: commit, item_frozen, item_frozen_digest: createHash('sha256').update(item_frozen).digest('hex') };
}

/** A landing state on the real repository whose batch holds items 7 and 8, with the setting as given; fake runners record what ran and in what order. */
async function landing(repo, { on = true, redFiles = [], rerunGreen = false } = {}) {
  const { root, batchRoot, base, tip } = repo;
  const rows = new Map([[7, frozenItem(tip, ALPHA)], [8, frozenItem(tip, BETA)]]);
  const batch = { version: 1, id: 'batch-7', state: 'gating', base, tip, root: batchRoot, branch: 'refs/heads/main',
    items: [{ id: 7, commit: tip }, { id: 8, commit: tip }], owner: 'coordinator', logPath: '/dev/null', conflicts: [], resolutions: [], revision: 0 };
  const writes = [];
  const calls = [];
  const write = async (name, [{ batch: next, revision }]) => {
    writes.push(name);
    if (name === 'recordLandingBatch') { validateLandingBatch(next, revision); return { ...next, revision: revision + 1 }; }
    return { ...batch, ...state.batch, state: 'finished' };
  };
  const state = { root, batch, config: on ? { landing: { sprintBarTests: true } } : {}, write, say: () => {}, checkLease: async () => {},
    readItem: id => rows.get(id), readEvents: () => [], board: { clock: { now: () => new Date('2026-11-17T20:00:00.000Z') } }, landingPorts: { validateQuarantineLandingProof() {} } };
  await save(state, { state: 'gating' });
  const runFiles = async (files, label) => {
    calls.push(`bar:${label}:${files.join(',')}`);
    const red = files.filter(file => redFiles.includes(file));
    return red.length ? { isGreen: false, output: red.map(file => `test at ${file}:1:1\n✖ case (3ms)`).join('\n') } : { isGreen: true };
  };
  state.sprintPorts = {
    ...(on ? { runBar: barTestPort(state, runFiles) } : {}),
    changedFiles: () => git(root, 'diff', '--name-only', base, tip).split('\n').filter(Boolean),
    pin: () => PIN,
    runStatic: async () => { calls.push('static'); return { isGreen: true }; },
    // The changed cell selects no test file, so its own run is green with nothing run: the gap this setting closes.
    runCell: async cell => { calls.push(cell); return { isGreen: true }; },
    rerunFile: async file => { calls.push(`rerun:${file}`); return { isGreen: rerunGreen }; },
    mainReceipt: () => null,
  };
  return { state, writes, calls };
}

test('landing.exact.sprint-bar-runs-items-bar-files: clause 1: with landing.sprintBarTests on the proof runs the union of every batch item\'s frozen bar test files once on the exact staged tree, after the static stage and before the cells, and records them per item on exactTree [C7,V16]', async t => {
  const repo = repository(t);
  const { state, calls } = await landing(repo);
  const record = await requireSprintProof(state);
  assert.deepEqual(calls, ['static', `bar:sprint-bar:${ALPHA},${BETA}`, 'packages/alpha', 'packages/beta'], 'static, one bar run of both items\' files, then each changed cell');
  assert.equal(record.result, 'green');
  assert.equal(record.tree, repo.treeOf(repo.tip), 'the record names the staged tree');
  assert.deepEqual(state.batch.exactTree.barTests, [{ item: 7, files: [ALPHA] }, { item: 8, files: [BETA] }]);
  assert.deepEqual(state.batch.exactTree.cells, ['packages/alpha', 'packages/beta']);
  calls.length = 0;
  assert.equal((await requireSprintProof(state)).result, 'green');
  assert.deepEqual(calls, [], 'an adopted batch whose green proof carries its bar record runs nothing again');
});

test('landing.exact.sprint-bar-red-or-missing-refuses: clause 2: with the setting on a red or missing bar test file leaves main where it was and refuses LAND_EXACT_RED naming the item and the file, though the changed cell selects no test file [C7,V16]', async t => {
  const repo = repository(t);
  const red = await landing(repo, { redFiles: [BETA] });
  await assert.rejects(() => requireSprintProof(red.state), error => error.code === 'LAND_EXACT_RED' && /item #8/u.test(error.message) && error.message.includes(BETA) && !error.message.includes(ALPHA));
  assert.equal(repo.main(), repo.base, 'main did not move');
  assert.equal(red.state.batch.state, 'blocked');
  assert.equal(red.state.batch.refusal.code, 'LAND_EXACT_RED');
  assert.equal(red.state.batch.exactTree.failed, 'bar');
  assert.equal(red.state.batch.exactTree.item, 8);
  assert.equal(red.writes.includes('finishLandingBatch'), false, 'no main-moved receipt for a red tree');
  assert.deepEqual(red.calls, ['static', `bar:sprint-bar:${ALPHA},${BETA}`, `rerun:${BETA}`], 'one rerun of the red file, and no cell runs after a red bar');
  const flaky = await landing(repo, { redFiles: [BETA], rerunGreen: true });
  await assert.rejects(() => requireSprintProof(flaky.state), error => error.code === 'LAND_EXACT_RED' && error.message.includes(BETA), 'a rerun that is green still needs main\'s green receipt for the file');
  rmSync(join(repo.batchRoot, ALPHA));
  const missing = await landing(repo);
  await assert.rejects(() => requireSprintProof(missing.state), error => error.code === 'LAND_EXACT_RED' && /item #7/u.test(error.message) && error.message.includes(ALPHA));
  assert.deepEqual(missing.calls, ['static'], 'a missing bar file runs no test and no cell');
  assert.equal(missing.state.batch.exactTree.item, 7);
  assert.equal(repo.main(), repo.base);
});

test('landing.exact.sprint-bar-off-unchanged: clause 3: with the setting off the proof runs no bar tests and its record is the one it was before [C7,V16]', async t => {
  const repo = repository(t);
  const off = await landing(repo, { on: false });
  const record = await requireSprintProof(off.state);
  assert.deepEqual(off.calls, ['static', 'packages/alpha', 'packages/beta']);
  assert.deepEqual(record, { tree: repo.treeOf(repo.tip), pin: PIN, cells: ['packages/alpha', 'packages/beta'], result: 'green' }, 'no barTests field');
  const base = { batch: { root: repo.batchRoot, base: repo.base, tip: repo.tip, items: [] } };
  assert.equal('runBar' in sprintPorts({ ...base, config: {} }), false, 'the real ports carry no bar port by default');
  assert.equal('runBar' in sprintPorts({ ...base, config: { landing: { sprintBarTests: false } } }), false);
  assert.equal(typeof sprintPorts({ ...base, config: { landing: { sprintBarTests: true } } }).runBar, 'function', 'the setting adds the bar port');
});
