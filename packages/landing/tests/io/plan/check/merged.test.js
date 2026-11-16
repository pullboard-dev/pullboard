/** A hand-landed commit meets the engine-numbering check that automatic landing applies [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { cleanGitEnvironment } from '../../../../../git/index.js';
import { requireLandingPlanCheck } from '../../../../index.js';

const roots = [];
const INIT = ['init', '-q', '-b', 'main'];
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

/** An empty repository with one base commit and no cells plan. */
function fixture() {
  const { root } = privateFixtureFiles('merged-engine-check-');
  roots.push(root);
  git(root, ...INIT);
  commit(root, { 'package.json': '{"type":"module"}\n' }, 'base');
  return root;
}

test('landing checks refuse an unnumbered engine leaf in the engines folder [C7]', () => {
  const root = fixture();
  const bad = commit(root, {
    'packages/state/src/logic/engines/new-rule-engine.js': "import { unassignedEngine } from './engine-next.js';\nexport const NEW_RULE_ENGINE = unassignedEngine();\n",
    'packages/state/src/logic/engines/unassigned.js': 'export function unassignedEngine() { return 999; }\n',
  }, 'placed but unnumbered engine leaf');
  assert.throws(() => requireLandingPlanCheck(root, bad), error => /engines\/new-rule-engine\.js/u.test(error.message) && /amendLandingEngines/u.test(error.message));
});

test('landing checks read the recorded numbered leaf despite dirty working bytes [C7]', () => {
  const root = fixture();
  const good = commit(root, {
    'packages/state/src/logic/engines/new-rule-engine.js': 'export const NEW_RULE_ENGINE = 1;\n',
  }, 'numbered engine leaf');
  const dirty = "import { unassignedEngine } from './engine-next.js';\nexport const NEW_RULE_ENGINE = unassignedEngine();\n";
  writeFileSync(join(root, 'packages/state/src/logic/engines/new-rule-engine.js'), dirty);
  assert.doesNotThrow(() => requireLandingPlanCheck(root, good));
  assert.equal(readFileSync(join(root, 'packages/state/src/logic/engines/new-rule-engine.js'), 'utf8'), dirty, 'the guard never numbers or rewrites the active checkout');
  assert.equal(git(root, 'rev-parse', 'HEAD'), good);
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
});

test('an unnumbered engine is refused even without a placement plan [C7]', () => {
  const { root } = privateFixtureFiles('merged-engine-no-plan-');
  roots.push(root);
  git(root, ...INIT);
  const bad = commit(root, {
    'packages/state/src/logic/engines/new-rule-engine.js': "import { unassignedEngine } from './engine-next.js';\nexport const NEW_RULE_ENGINE = unassignedEngine();\n",
  }, 'unnumbered with no plan');
  assert.throws(() => requireLandingPlanCheck(root, bad), error => error.code === 'LAND_ENGINE_UNNUMBERED'
    && /engines\/new-rule-engine\.js/u.test(error.message) && /amendLandingEngines/u.test(error.message));
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1, 'a refused engine leaves no scratch checkout');
});
