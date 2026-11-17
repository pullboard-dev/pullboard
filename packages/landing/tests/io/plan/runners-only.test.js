/** With gate.runnersOnly on, the cells-plan check reads Git objects only and still refuses an unnumbered engine [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { cleanGitEnvironment } from '../../../../git/index.js';
import { realGitAdapter } from '../../../../git/index.js';
import { withGitAdapter } from '../../../../git/index.js';
import { landingPlanCheck } from '../../../src/io/plan/check.js';

const roots = [];
const INIT = ['init', '-q', '-b', 'main'];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** Run Git in a fixture repository and return the trimmed output. */
function git(root, ...args) {
  const run = spawnSync('git', args, { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

/** A repository with one commit holding the given files; returns its root and commit. */
function repoWith(files) {
  const { root } = privateFixtureFiles('runners-only-plan-');
  roots.push(root);
  git(root, ...INIT);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'base');
  return { root, commit: git(root, 'rev-parse', 'HEAD') };
}

/** Run the plan check with gate.runnersOnly on and every spawned Git command recorded; the adapter is the only spawn route the check has. */
async function recorded(root, commit) {
  const { root: home } = privateFixtureFiles('runners-only-home-');
  roots.push(home);
  fixtureMachineSettings(home, { gate: { runnersOnly: true } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  const spawned = [];
  const spy = { ...realGitAdapter, spawnSync(args, options) { spawned.push(['git', ...args]); return realGitAdapter.spawnSync(args, options); },
    execFileSync(args, options) { spawned.push(['git', ...args]); return realGitAdapter.execFileSync(args, options); },
    spawn(args, options) { spawned.push(['git', ...args]); return realGitAdapter.spawn(args, options); } };
  try {
    const outcome = await withGitAdapter(spy, async () => { try { await landingPlanCheck(root, commit); return null; } catch (error) { return error; } });
    return { spawned, outcome };
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

const NUMBERED = { 'packages/state/src/logic/engines/new-rule-engine.js': 'export const NEW_RULE_ENGINE = 1;\n' };
const PLACEHOLDER = { 'packages/state/src/logic/engines/new-rule-engine.js': "import { unassignedEngine } from './engine-next.js';\nexport const NEW_RULE_ENGINE = unassignedEngine();\n" };

test('landing.runners-only.with-gate-runnersonly-on-the-cells: clause 1: with gate.runnersOnly on, the cells-plan check spawns only git ls-tree and git cat-file, no node or test process [C7]', async () => {
  const { root, commit } = repoWith(NUMBERED);
  const { spawned, outcome } = await recorded(root, commit);
  assert.equal(outcome, null, 'a numbered engine passes');
  assert.ok(spawned.length > 0, 'the check read Git objects');
  for (const command of spawned) assert.ok(command[0] === 'git' && ['ls-tree', 'cat-file'].includes(command[1]), `only ls-tree and cat-file, got ${command.join(' ')}`);
  assert.ok(spawned.some(command => command[1] === 'cat-file'), 'the engine blob was read from the object store');
});

test('landing.runners-only.with-gate-runnersonly-on-an-unnumbered: clause 2: with gate.runnersOnly on, an unnumbered engine placeholder on the checked commit still refuses LAND_ENGINE_UNNUMBERED [C7]', async () => {
  const { root, commit } = repoWith(PLACEHOLDER);
  const { spawned, outcome } = await recorded(root, commit);
  assert.equal(outcome?.code, 'LAND_ENGINE_UNNUMBERED');
  for (const command of spawned) assert.ok(['ls-tree', 'cat-file'].includes(command[1]), `only ls-tree and cat-file, got ${command.join(' ')}`);
});
