/** @pullboard-test-input packages/codemap/data/plan/seed.json packages/codemap/src/io/cells/scripts/plan.js packages/state/data/history/legacy.json */
/** A real landing merge allocates and places history before exposing its amended commit [B3,C7,D3,H16]. */
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
import { amendLandingEngines } from '../../../index.js';
import { computePlan } from '../../../../codemap/index.js';
import { writePlan } from '../../../../codemap/index.js';
import { git } from '../../fixtures/plan.js';

const BIN = fileURLToPath(new URL('../../../../codemap/src/io/cells/scripts/plan.js', import.meta.url));

/** Build an actual two-parent item merge with a new engine leaf and the production canonical plan tool. */
function fixture(t, { deleteMoves = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-land-engine-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Write a synthetic source input, never a replacement for the production placement implementation. */
  function put(file, text) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  put('package.json', '{"type":"module"}\n');
  put('packages/state/src/logic/engines/base-engine.js', 'export const BASE_ENGINE = 80;\n');
  put('packages/state/src/logic/engines/unassigned.js', 'export const unassignedEngine = () => 81;\n');
  put('src/moves/example.js', 'export default { operation: "fixture", engine: 80 };\n');
  // The moves cell holds the body; the item may delete the src/moves shim folder, as #1704 does.
  put('packages/moves/src/logic/moves/example.js', 'export default { operation: "fixture", engine: 80 };\n');
  put('packages/state/data/history/legacy.json', '{"version":1}\n');
  // The fixture launcher delegates unchanged arguments to the actual canonical CLI, with this repository as cwd.
  put('packages/codemap/src/io/cells/scripts/plan.js', `import { spawnSync } from 'node:child_process';\nconst result = spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...process.argv.slice(2)], { stdio: 'inherit' });\nprocess.exitCode = result.status ?? 1;\n`);
  put('packages/codemap/data/plan/seed.json', JSON.stringify({ source: 'synthetic landing input', sha256: 'none',
    order: ['state', 'app:cli'], cells: { state: [
      'src/moves/example.js', 'packages/moves/src/logic/moves/example.js', 'packages/state/data/history/legacy.json'], 'app:cli': ['packages/codemap/src/io/cells/scripts/plan.js'] }, tests: {} }));
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Landing fixture'], ['config', 'user.email', 'landing@example.invalid'], ['add', '-A'], ['commit', '-q', '-m', 'fixture base']])
    git(root, ...args);
  writePlan(root, computePlan(root));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture plan');
  git(root, 'checkout', '-q', '-b', 'fixture-item');
  // An engine leaf lives in the state cell's engines folder, outside the plan's scope, so it needs no placement row.
  put('packages/state/src/logic/engines/feature-engine.js', "import { unassignedEngine } from './engine-next.js';\nexport const FEATURE_ENGINE = unassignedEngine();\n");
  git(root, 'add', 'packages/state/src/logic/engines/feature-engine.js');
  if (deleteMoves) git(root, 'rm', '-rq', 'src/moves');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture item');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', 'fixture-item', '-m', 'fixture landing');
  return { root, merge: git(root, 'rev-parse', 'HEAD') };
}

test('an allocating landing commits its new history as data in the same merge [B3,C7,D3,H16]', t => {
  const { root, merge } = fixture(t);
  const parents = git(root, 'show', '-s', '--format=%P', merge);
  assert.equal(parents.split(' ').length, 2, 'the input is a real item merge');
  const engines = amendLandingEngines(root);
  assert.deepEqual(engines.assigned, [{ name: 'FEATURE_ENGINE', number: 81 }]);
  const head = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(head, merge);
  assert.equal(git(root, 'show', '-s', '--format=%P', head), parents, 'allocation and placement amend that same merge');
  const history = 'packages/state/data/history/81.json';
  assert.equal(JSON.parse(git(root, 'show', `${head}:${history}`)).engine, 81);
  assert.equal(git(root, 'status', '--porcelain'), '', 'no unstaged file escapes the merge');
  assert.deepEqual(amendLandingEngines(root).assigned, [], 'a retry never allocates or places the same history twice');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
});

test('landing a candidate that deletes src/moves numbers its engine from the moves cell [C7,H16]', t => {
  const { root } = fixture(t, { deleteMoves: true });
  const engines = amendLandingEngines(root);
  assert.deepEqual(engines.assigned, [{ name: 'FEATURE_ENGINE', number: 81 }]);
  const record = JSON.parse(git(root, 'show', 'HEAD:packages/state/data/history/81.json'));
  assert.deepEqual(Object.keys(record.declarations), ['example.js'], 'the history freezes the packaged body');
});
