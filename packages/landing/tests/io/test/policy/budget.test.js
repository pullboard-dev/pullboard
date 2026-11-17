/** Real file dispatch enforces a committed per-file budget and its accepted-main ratchet [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../../../../gate/tests/fixtures/child.js';
import { DEFAULT_TEST_FILE_BUDGET_MS } from '../../../../../gate/index.js';
import { readTestFileBudgets } from '../../../../../gate/index.js';
import { requireTestFileRatchet } from '../../../../../gate/index.js';
import { testFileBudgetFailure } from '../../../../../gate/index.js';
import { testFileBudgetPath } from '../../../../../gate/index.js';
import { writePlacementIndex } from '../../../../../gate/index.js';
import { indexedStageSelection } from '../../../../../gate/index.js';
import { inCleanCheckout } from '../../../../../gate/index.js';
import { withMainCheckout } from '../../../../src/io/main/red.js';
import { runnerPolicyRecord } from '../../../../../sandbox/index.js';
import { RUNNER_POLICY_FILE } from '../../../../../sandbox/index.js';

const runner = fileURLToPath(new URL('../../../../../../apps/cli/src/io/run/tests.js', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-file-budget-'));
  const main = join(directory, 'main'), candidate = join(directory, 'candidate');
  mkdirSync(main);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const result = runFixtureChild('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(main, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(main, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(main, 'slow.test.js'), "import {test} from 'node:test'; test('slow fixture [C7]', async()=>{await new Promise(done=>setTimeout(done,40));});\n");
  writeFileSync(join(main, 'later.test.js'), "import {test} from 'node:test'; test('later fixture [C7]',()=>{});\n");
  const path = testFileBudgetPath('slow.test.js');
  mkdirSync(dirname(join(main, path)), { recursive: true });
  writeFileSync(join(main, path), JSON.stringify({ version: 1, file: 'slow.test.js', ms: 1 }));
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'fixture main');
  git(main, 'worktree', 'add', '-qb', 'candidate', candidate);
  const run = (cwd = candidate, files = ['slow.test.js', 'later.test.js'], flags = []) => runFixtureChild(process.execPath, [runner, ...flags, ...files], {
    cwd, env: { ...process.env, PULLBOARD_MACHINE_HOME: join(directory, 'machine'), PULLBOARD_TEST_NO_FILE_LIMIT: '' }, encoding: 'utf8', detached: true,
  });
  return { main, candidate, git, path, run };
}

test('landing.budget.a-dirty-seat-snapshot-carries-accepted: a dirty seat snapshot carries accepted main into its detached runner checkout [C7]', async t => {
  const box = fixture(t);
  writeFileSync(join(box.candidate, 'later.test.js'), "import {test} from 'node:test'; test('changed',()=>{});\n");
  await inCleanCheckout(box.candidate, async snapshot => {
    assert.notEqual(snapshot, box.candidate);
    assert.equal(readTestFileBudgets(snapshot, ['slow.test.js']).get('slow.test.js').ms, 1);
    assert.equal(box.git(snapshot, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'snapshot is detached');
  }, withMainCheckout);
});

test('landing.budget.a-linked-item-worktree-uses-its: a linked item worktree uses its runner primary admitted trunk [C7]', async t => {
  const box = fixture(t);
  const commit = box.git(box.main, 'rev-parse', 'HEAD^{commit}');
  const tree = box.git(box.main, 'rev-parse', 'HEAD^{tree}');
  box.git(box.main, 'checkout', '--quiet', '--detach');
  writeFileSync(join(box.main, '.git', RUNNER_POLICY_FILE), JSON.stringify(runnerPolicyRecord({ id: 'fixture', commit, tree,
    trunk: { ref: 'refs/heads/main', commit } })));
  assert.equal(readTestFileBudgets(box.candidate, ['slow.test.js']).get('slow.test.js').ms, 1);
  writeFileSync(join(box.candidate, 'later.test.js'), "import {test} from 'node:test'; test('changed',()=>{});\n");
  await inCleanCheckout(box.candidate, async snapshot => {
    assert.equal(readTestFileBudgets(snapshot, ['slow.test.js']).get('slow.test.js').ms, 1);
  }, withMainCheckout);
  writeFileSync(join(box.candidate, box.path), JSON.stringify({ version: 1, file: 'slow.test.js', ms: 2 }));
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'loosen budget');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), /may not increase from 1ms to 2ms/u);
  writeFileSync(join(box.candidate, box.path), '{broken');
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'malformed budget');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), error => error.message.includes(box.path));
  writeFileSync(join(box.candidate, box.path), JSON.stringify({ version: 1, file: 'slow.test.js', ms: -1 }));
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'invalid budget');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), error => error.message.includes(box.path));
});

test('landing.budget.a-detached-repository-without-trusted-trunk: a detached repository without trusted trunk fails closed with guidance [C7]', t => {
  const box = fixture(t);
  box.git(box.main, 'checkout', '--quiet', '--detach');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']),
    error => error.code === 'NO_POLICY' && /detached for review; ask it to return to its main branch/u.test(error.message));
});

test('landing.budget.an-over-budget-file-fails-with: an over-budget file fails with its observed runtime, while audit placement passes [C7]', t => {
  const box = fixture(t);
  const red = box.run(), output = `${red.stdout ?? ''}${red.stderr ?? ''}`;
  assert.equal(red.status, 1, output);
  assert.match(output, /slow\.test\.js took \d+ms, over its 1ms test file budget/u);
  assert.match(output, /later fixture \[C7\]/u, 'a budget failure does not discard other test output');
  const subdirectory = join(box.candidate, 'subdirectory');
  mkdirSync(subdirectory);
  const subdir = box.run(subdirectory, ['../slow.test.js']);
  assert.equal(subdir.status, 1);
  assert.match(`${subdir.stdout ?? ''}${subdir.stderr ?? ''}`, /slow\.test\.js took \d+ms/u, 'budgets use repository-relative paths');
  const dot = box.run(box.candidate, ['slow.test.js'], ['--test-reporter=dot']);
  assert.equal(dot.status, 1);
  assert.match(dot.stderr, /slow\.test\.js took \d+ms/u, 'the measured budget failure survives reporters that omit diagnostics');
  writePlacementIndex(box.candidate, { version: 1, files: [{ file: 'slow.test.js', tier: 'audit', testInputs: [] }] });
  const derived = box.run();
  assert.equal(derived.status, 1, 'a derived placement cannot grant a budget exemption');
  writeFileSync(join(box.candidate, box.path), JSON.stringify({ version: 1, file: 'slow.test.js', ms: 1, placement: 'audit' }));
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'move to audit');
  writePlacementIndex(box.candidate, { version: 1, files: [{ file: 'slow.test.js', tier: 'submit', testInputs: [] }] });
  assert.deepEqual(indexedStageSelection(box.candidate, ['slow.test.js'], 'submit'), []);
  assert.deepEqual(indexedStageSelection(box.candidate, ['slow.test.js'], 'audit'), ['slow.test.js']);
  const green = box.run();
  assert.equal(green.status, 0, `${green.stdout ?? ''}${green.stderr ?? ''}`);
});

test('landing.budget.a-candidate-cannot-loosen-or-remove: a candidate cannot loosen or remove an accepted file limit [C7]', t => {
  const box = fixture(t);
  writeFileSync(join(box.candidate, box.path), JSON.stringify({ version: 1, file: 'slow.test.js', ms: 2 }));
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'loosen');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), /may not increase from 1ms to 2ms/u);
  assert.throws(() => readTestFileBudgets(box.candidate, []), /may not increase from 1ms to 2ms/u, 'unselected rows cannot loosen');
  box.git(box.candidate, 'rm', '-q', box.path, 'pullboard.json'); box.git(box.candidate, 'commit', '-qm', 'remove');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), /may not increase from 1ms/u);
  mkdirSync(dirname(join(box.candidate, box.path)), { recursive: true });
  writeFileSync(join(box.candidate, box.path), JSON.stringify({ version: 1, file: 'slow.test.js' }));
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'malformed');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), /invalid test file budget row/u);
});

test('landing.budget.the-default-test-file-budget-is: the default test file budget is 120 s [C7]', () => {
  assert.equal(DEFAULT_TEST_FILE_BUDGET_MS, 120000);
});

test('landing.budget.a-file-with-no-recorded-row: a file with no recorded row that runs 121 s fails its gate naming the file and the split [C7]', t => {
  const box = fixture(t);
  assert.equal(readTestFileBudgets(box.candidate, ['later.test.js']).get('later.test.js').ms, 120000, 'an unrecorded file gets the default');
  const message = testFileBudgetFailure('later.test.js', 121000, DEFAULT_TEST_FILE_BUDGET_MS);
  assert.match(message, /later\.test\.js took 121000ms, over its 120000ms test file budget; split it/u);
  assert.equal(testFileBudgetFailure('later.test.js', 120000, DEFAULT_TEST_FILE_BUDGET_MS), null, 'exactly the budget passes');
});

test('landing.budget.a-recorded-row-stays-the-limit: a recorded row stays the limit and can only go down [C7]', () => {
  assert.equal(testFileBudgetFailure('slow.test.js', 5000, 1000)?.includes('over its 1000ms'), true, 'the row, not the default, is the limit');
  assert.equal(requireTestFileRatchet('slow.test.js', 500000, 400000), 400000);
  assert.throws(() => requireTestFileRatchet('slow.test.js', 400000, 500000), /may not increase from 400000ms to 500000ms/u);
});
