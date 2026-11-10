/** A hand-landed commit meets the cells-plan placement check that automatic landing applies [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { cleanGitEnvironment } from '../../../../../git/index.js';
import { requireLandingPlanCheck } from '../../../../index.js';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** Run Git in a fixture repository and return the trimmed output. */
function git(root, ...args) {
  const run = spawnSync('git', args, { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** Commit the given files into the fixture and return the new commit. */
function commit(root, files, message) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

/** A repository whose own plan tool reports each tracked bin file the plan omits, as packages/codemap/src/io/cells/scripts/plan.js --check does. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'merged-plan-check-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  const tool = [
    "import { existsSync, readdirSync, readFileSync } from 'node:fs';",
    "const placed = JSON.parse(readFileSync('packages/codemap/data/plan/cells.json', 'utf8')).placed;",
    "const dir = 'apps/cli/src/io/hook';",
    "const missing = existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.js') && !placed.includes(`${dir}/${file}`)) : [];",
    "for (const file of missing) console.error(`not in packages/codemap/data/plan/cells.json: ${dir}/${file}`);",
    'process.exitCode = missing.length ? 1 : 0;',
    '',
  ].join('\n');
  commit(root, { 'packages/codemap/src/io/cells/scripts/plan.js': tool, 'packages/codemap/data/plan/cells.json': '{"placed":[]}\n', 'package.json': '{"type":"module"}\n' }, 'base');
  return root;
}

test('merged refuses a landing commit with an unplaced path and names it [C7]', () => {
  const root = fixture();
  const bad = commit(root, { 'apps/cli/src/io/hook/composed.js': 'export {};\n' }, 'unplaced');
  assert.throws(() => requireLandingPlanCheck(root, bad), error => error.code === 'LAND_PLAN_UNPLACED' && /apps\/cli\/src\/io\/hook\/composed\.js/u.test(error.message));
});

test('merged accepts a landing commit whose paths are all placed, and a repository with no plan [C7]', () => {
  const root = fixture();
  const good = commit(root, { 'apps/cli/src/io/hook/composed.js': 'export {};\n', 'packages/codemap/data/plan/cells.json': '{"placed":["apps/cli/src/io/hook/composed.js"]}\n' }, 'placed');
  assert.doesNotThrow(() => requireLandingPlanCheck(root, good));
  const bare = mkdtempSync(join(tmpdir(), 'merged-plan-bare-'));
  roots.push(bare);
  git(bare, 'init', '-q', '-b', 'main');
  const first = commit(bare, { 'README.md': 'x\n', 'src/local-engine.js': 'export const LOCAL_ENGINE = \"project-owned\";\n' }, 'bare');
  assert.doesNotThrow(() => requireLandingPlanCheck(bare, first));
});

test('the scratch checkout is gone after the check, pass or fail [C7]', () => {
  const root = fixture();
  const bad = commit(root, { 'apps/cli/src/io/hook/x.js': 'export {};\n' }, 'unplaced');
  assert.throws(() => requireLandingPlanCheck(root, bad));
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
});


test('landing checks refuse an unnumbered engine leaf in the engines folder [C7]', () => {
  const root = fixture();
  const bad = commit(root, {
    'packages/state/src/logic/engines/new-rule-engine.js': "import { unassignedEngine } from './engine-next.js';\nexport const NEW_RULE_ENGINE = unassignedEngine();\n",
    'packages/state/src/logic/engines/unassigned.js': 'export function unassignedEngine() { return 999; }\n',
    'packages/codemap/data/plan/cells.json': '{"placed":[]}\n',
  }, 'placed but unnumbered engine leaf');
  assert.throws(() => requireLandingPlanCheck(root, bad), error => /engines\/new-rule-engine\.js/u.test(error.message) && /amendLandingEngines/u.test(error.message));
});

test('landing checks read the recorded numbered leaf despite dirty working bytes [C7]', () => {
  const root = fixture();
  const good = commit(root, {
    'packages/state/src/logic/engines/new-rule-engine.js': 'export const NEW_RULE_ENGINE = 1;\n',
    'packages/codemap/data/plan/cells.json': '{"placed":[]}\n',
  }, 'numbered engine leaf');
  const dirty = "import { unassignedEngine } from './engine-next.js';\nexport const NEW_RULE_ENGINE = unassignedEngine();\n";
  writeFileSync(join(root, 'packages/state/src/logic/engines/new-rule-engine.js'), dirty);
  assert.doesNotThrow(() => requireLandingPlanCheck(root, good));
  assert.equal(readFileSync(join(root, 'packages/state/src/logic/engines/new-rule-engine.js'), 'utf8'), dirty, 'the guard never numbers or rewrites the active checkout');
  assert.equal(git(root, 'rev-parse', 'HEAD'), good);
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
});

test('an unnumbered engine is refused even without a placement plan [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'merged-engine-no-plan-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  const bad = commit(root, {
    'packages/state/src/logic/engines/new-rule-engine.js': "import { unassignedEngine } from './engine-next.js';\nexport const NEW_RULE_ENGINE = unassignedEngine();\n",
  }, 'unnumbered with no plan');
  assert.throws(() => requireLandingPlanCheck(root, bad), error => error.code === 'LAND_ENGINE_UNNUMBERED'
    && /engines\/new-rule-engine\.js/u.test(error.message) && /amendLandingEngines/u.test(error.message));
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1, 'a refused engine leaves no scratch checkout');
});
