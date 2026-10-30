/** @pullboard-test-input source-tree */
/** A real landing merge allocates and places history before exposing its amended commit [B3,C7,D3,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { amendLandingEngines } from '../src/landing-step-merge.js';
import { computePlan, placePath, readPlan, writePlan } from '../bin/cells-plan.js';
import { git } from './cells-plan-fixture.js';
import { runFixtureChild } from './fixture-child.js';

const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));

/** Build an actual two-parent item merge with a new engine leaf and the production canonical plan tool. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-land-engine-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Write a synthetic source input, never a replacement for the production placement implementation. */
  function put(file, text) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  put('package.json', '{"type":"module"}\n');
  put('src/base-engine.js', 'export const BASE_ENGINE = 80;\n');
  put('src/engine-next.js', 'export const unassignedEngine = () => 81;\n');
  put('src/moves/example.js', 'export default { operation: "fixture", engine: 80 };\n');
  put('src/move-history/legacy.json', '{"version":1}\n');
  // The fixture launcher delegates unchanged arguments to the actual canonical CLI, with this repository as cwd.
  put('bin/cells-plan.js', `import { spawnSync } from 'node:child_process';\nconst result = spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...process.argv.slice(2)], { stdio: 'inherit' });\nprocess.exitCode = result.status ?? 1;\n`);
  put('bin/cells-plan/seed.json', JSON.stringify({ source: 'synthetic landing input', sha256: 'none',
    order: ['state', 'app:cli'], cells: { state: ['src/base-engine.js', 'src/engine-next.js',
      'src/moves/example.js', 'src/move-history/legacy.json'], 'app:cli': ['bin/cells-plan.js'] }, tests: {} }));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Landing fixture'], ['config', 'user.email', 'landing@example.invalid'], ['add', '-A'], ['commit', '-q', '-m', 'fixture base']])
    assert.equal(git(root, ...args).status, 0);
  writePlan(root, computePlan(root));
  assert.equal(git(root, 'add', '-A').status, 0);
  assert.equal(git(root, 'commit', '-q', '-m', 'fixture plan').status, 0);
  assert.equal(git(root, 'checkout', '-q', '-b', 'fixture-item').status, 0);
  put('src/feature-engine.js', "import { unassignedEngine } from './engine-next.js';\nexport const FEATURE_ENGINE = unassignedEngine();\n");
  assert.equal(git(root, 'add', 'src/feature-engine.js').status, 0);
  placePath(root, 'src/feature-engine.js', { cell: 'state' });
  assert.equal(git(root, 'add', '-A').status, 0);
  assert.equal(git(root, 'commit', '-q', '-m', 'fixture item').status, 0);
  assert.equal(git(root, 'checkout', '-q', 'main').status, 0);
  assert.equal(git(root, 'merge', '-q', '--no-ff', 'fixture-item', '-m', 'fixture landing').status, 0);
  return { root, merge: git(root, 'rev-parse', 'HEAD').stdout.trim() };
}

test('an allocating landing places its new history by rule in the same merge and leaves cells-plan green [B3,C7,D3,H16]', t => {
  const { root, merge } = fixture(t);
  const parents = git(root, 'show', '-s', '--format=%P', merge).stdout.trim();
  assert.equal(parents.split(' ').length, 2, 'the input is a real item merge');
  const engines = amendLandingEngines(root);
  assert.deepEqual(engines.assigned, [{ name: 'FEATURE_ENGINE', number: 81 }]);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  assert.notEqual(head, merge);
  assert.equal(git(root, 'show', '-s', '--format=%P', head).stdout.trim(), parents, 'allocation and placement amend that same merge');
  const history = 'src/move-history/81.json';
  assert.equal(JSON.parse(git(root, 'show', `${head}:${history}`).stdout).engine, 81);
  const state = readPlan(root).cells.find(cell => cell.name === 'state');
  assert.deepEqual(state.paths.filter(([from]) => from === history), [[history, 'packages/state/src/shell/move-history/81.json', 'rule']]);
  const committed = JSON.parse(git(root, 'show', `${head}:bin/cells-plan/01-state.json`).stdout);
  assert.deepEqual(committed.paths.find(([from]) => from === history), state.paths.find(([from]) => from === history));
  const checked = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.equal(git(root, 'status', '--porcelain').stdout, '', 'no unplaced file or unstaged plan escapes the merge');
  assert.deepEqual(amendLandingEngines(root).assigned, [], 'a retry never allocates or places the same history twice');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), head);
});

test('a canonical placement failure refuses before an unplaced history can be committed [B3,C7,D3,H16]', t => {
  const { root, merge } = fixture(t);
  rmSync(join(root, 'bin/cells-plan/01-state.json'));
  assert.throws(() => amendLandingEngines(root), error => error.code === 'LAND_MERGE' && /src\/move-history\/81\.json/u.test(error.message));
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), merge, 'the original merge was not amended after a failed placement');
  assert.notEqual(git(root, 'cat-file', '-e', `${merge}:src/move-history/81.json`).status, 0, 'unplaced allocation never entered committed history');
});
