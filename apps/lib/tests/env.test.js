/** @pullboard-test-input source-tree */
/** Real child commands cannot carry a caller's repository into a private Git fixture [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runShell } from '../../../packages/gate/index.js';
import { cellSandbox } from '../../../packages/store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../cli/tests/fixtures/child.js';

const SELECTORS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
const RUNNER = fileURLToPath(new URL('../../../packages/gate/src/io/run/tests.js', import.meta.url));

/** Create only disposable repositories; every deliberately supplied Git selector stays inside this fixture. */
function fixture(t) {
  const box = cellSandbox(t);
  const scratch = join(box.dir, 'scratch');
  const work = join(box.dir, 'work');
  mkdirSync(scratch);
  mkdirSync(work);
  box.git(scratch, 'init', '-q', '-b', 'main');
  box.git(work, 'init', '-q', '-b', 'main');
  const config = join(scratch, '.git', 'config');
  return { ...box, scratch, work, config, before: readFileSync(config) };
}

/** Require one name-only removal notice, without printing selector values or private paths. */
function notice(output, names, paths) {
  const lines = output.split('\n').filter(line => line.includes('removed inherited Git selectors:'));
  assert.equal(lines.length, 1, output);
  for (const name of names) assert.ok(lines[0].includes(name), name);
  for (const path of paths) assert.ok(!lines[0].includes(path), 'the diagnostic names selectors without their values');
}

test('run-tests clears inherited Git selectors before discovery and a fixture bare init preserves the scratch config [C7]', t => {
  const box = fixture(t);
  const target = join(box.work, 'bare-target');
  mkdirSync(target);
  writeFileSync(join(box.work, 'package.json'), '{"type":"module"}\n');
  const probe = join(box.work, 'selectors.test.js');
  writeFileSync(probe, `import assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\nimport { test } from 'node:test';\n/** Check the actual file worker before Git can select any inherited repository. */\ntest('private bare init has no inherited selectors [C7]', () => {\n  for (const key of ${JSON.stringify(SELECTORS)}) assert.equal(process.env[key], undefined, key);\n  const result = spawnSync('git', ['init', '--bare', '-q'], { cwd: ${JSON.stringify(target)}, encoding: 'utf8' });\n  assert.equal(result.status, 0, result.stderr);\n});\n`);
  box.git(box.work, 'add', '-A');
  box.git(box.work, 'commit', '-q', '-m', 'test: seed private selector fixture');
  const git = join(box.scratch, '.git');
  const env = { ...box.env, GIT_DIR: git, GIT_WORK_TREE: box.scratch,
    GIT_INDEX_FILE: join(git, 'index'), GIT_COMMON_DIR: git, GIT_OBJECT_DIRECTORY: join(git, 'objects') };
  delete env.NODE_TEST_CONTEXT;
  const child = runFixtureChild(process.execPath, [RUNNER, probe], { cwd: box.work, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.failure ?? child.stdout + child.stderr);
  assert.deepEqual(readFileSync(box.config), box.before, 'the selected scratch repository config stays byte-identical');
  assert.equal(box.git(target, 'rev-parse', '--is-bare-repository'), 'true', 'Git actually initialized the separate target');
  notice(child.stdout + child.stderr, SELECTORS, [git, box.scratch]);
});

test('a gate env override cannot carry GIT_DIR into bare init of a separate fixture [C7]', t => {
  const box = fixture(t);
  const target = join(box.work, 'gate-target');
  mkdirSync(target);
  const git = join(box.scratch, '.git');
  const result = runShell(target, 'git init --bare -q', { env: { GIT_DIR: git } });
  assert.equal(result.isGreen, true, result.output);
  assert.deepEqual(readFileSync(box.config), box.before, 'the gate command never changes the other scratch repository config');
  assert.equal(box.git(target, 'rev-parse', '--is-bare-repository'), 'true', 'the actual gate command initialized its own target');
  notice(result.output, ['GIT_DIR'], [git, box.scratch]);
});
