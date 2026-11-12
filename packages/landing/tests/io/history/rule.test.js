/** @pullboard-test-input packages/codemap/data/plan/cells.json packages/codemap/data/plan/seed.json packages/codemap/src/io/cells/scripts/plan.js */
/** A landing that adds a file the cells plan does not cover places it by the plan's rule, so main's cells-plan check stays green [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { amendLandingEngines } from '../../../index.js';
import { placeLandingNewFiles } from '../../../index.js';
import { computePlan } from '../../../../codemap/index.js';
import { readPlan } from '../../../../codemap/index.js';
import { writePlan } from '../../../../codemap/index.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';

const BIN = fileURLToPath(new URL('../../../../codemap/src/io/cells/scripts/plan.js', import.meta.url));
const REASON = 'explicit bounded placement: stays in place during the move';

/** Build a real two-parent item merge whose item adds the given files without touching the plan. */
function fixture(t, added) {
  const { root } = privateFixtureFiles('pullboard-land-new-file-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Write a synthetic source input, never a replacement for the production placement implementation. */
  function put(file, text) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  put('package.json', '{"type":"module"}\n');
  put('src/base.js', 'export const base = 1;\n');
  // The fixture launcher delegates unchanged arguments to the production plan command, with this repository as cwd.
  put('packages/codemap/src/io/cells/scripts/plan.js', `import { spawnSync } from 'node:child_process';\nconst result = spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...process.argv.slice(2)], { stdio: 'inherit' });\nprocess.exitCode = result.status ?? 1;\n`);
  put('packages/codemap/data/plan/seed.json', JSON.stringify({ source: 'synthetic landing input', sha256: 'none',
    order: ['state', 'app:cli'], cells: { state: ['src/base.js'], 'app:cli': ['packages/codemap/src/io/cells/scripts/plan.js'] }, tests: {} }));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Landing fixture'], ['config', 'user.email', 'landing@example.invalid'], ['add', '-A'], ['commit', '-q', '-m', 'fixture base']])
    git(root, ...args);
  writePlan(root, computePlan(root));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture plan');
  git(root, 'checkout', '-q', '-b', 'fixture-item');
  for (const file of added) put(file, 'export const demo = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'fixture item');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', 'fixture-item', '-m', 'fixture landing');
  return { root, merge: git(root, 'rev-parse', 'HEAD') };
}

/** Run the production plan check in the fixture. */
function check(root) {
  return runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
}

test('clause 1: a landed new bin/ or src/ file outside the engine and move-history rules is placed by rule [C7]', t => {
  const files = ['bin/checks/demo-tool.js', 'bin/demo-top.js', 'src/demo-feature.js'];
  const { root, merge } = fixture(t, files);
  const before = check(root);
  assert.notEqual(before.status, 0, 'the landing leaves its new files unplaced until the landing step runs');
  for (const file of files) assert.match(before.stdout + before.stderr, new RegExp(`not in packages/codemap/data/plan/cells\\.json: ${file.replace(/[./]/gu, '\\$&')}`, 'u'));
  const parents = git(root, 'show', '-s', '--format=%P', merge);
  amendLandingEngines(root);
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(git(root, 'show', '-s', '--format=%P', head), parents, 'placement amends the same item merge');
  const plan = readPlan(root);
  for (const file of files) assert.deepEqual(plan.stays.find(row => row.path === file), { path: file, reason: REASON }, file);
  const committed = JSON.parse(git(root, 'show', `${head}:packages/codemap/data/plan/cells.json`));
  for (const file of files) assert.ok(committed.stays.some(row => row.path === file), `${file} is in the landing commit's plan`);
  const after = check(root);
  assert.equal(after.status, 0, after.stderr + after.stdout);
  assert.equal(git(root, 'status', '--porcelain'), '', 'no unplaced file or unstaged plan escapes the merge');
  amendLandingEngines(root);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'a retry places nothing twice');
});

test('clause 1: a landing whose files the plan already covers is left byte-identical [C7]', t => {
  const { root, merge } = fixture(t, []);
  amendLandingEngines(root);
  assert.equal(git(root, 'rev-parse', 'HEAD'), merge);
});

test('clause 1: placing a hand-landed file in the checkout leaves main with no unplaced path [C7]', t => {
  const { root, merge } = fixture(t, ['bin/checks/demo-hand.js']);
  const files = placeLandingNewFiles(root);
  assert.ok(files.includes('packages/codemap/data/plan/cells.json'), files.join(','));
  git(root, 'add', '--', ...files);
  git(root, 'commit', '-q', '-m', 'chore(cells): place new files in the plan [C7]');
  assert.equal(git(root, 'rev-parse', 'HEAD^'), merge, 'the chore commit sits directly on the landing');
  const after = check(root);
  assert.equal(after.status, 0, after.stderr + after.stdout);
  assert.equal(readPlan(root).stays.find(row => row.path === 'bin/checks/demo-hand.js')?.reason, REASON);
  assert.deepEqual(placeLandingNewFiles(root), [], 'a tree the plan already covers needs no follow-up');
});
