/** The shared real-CLI fixtures for the submit gate: a private repository, a joined builder and a small import graph [V4,C7,V16]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from '../child.js';
import { runFixtureGit } from '../child.js';
import { fixtureMachineSettings } from '../testkit.js';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';

const BIN = resolveBin();
const dirs = [];
export const SPEC = '# Submit proof fixture\n\n## G · Goals\n- G1 [approved, must] The selected test proves the change. | gate: test\n';

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
});

/** Resolve the real CLI relative to this test without importing any project dependencies. */
function resolveBin() {
  return join(import.meta.dirname, '../../../pullboard.js');
}

/** Create a private Git repository with a deterministic identity and isolated Pullboard home. */
export function privateRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-gate-')));
  dirs.push(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  // These submits hold their gate in the submitting process, so the fixture pins controller dispatch [P7].
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
  /** Run real Git in this fixture with only the fixture's configured identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Run the real local CLI, retaining JSON stdout and refusal stderr separately. */
  const run = (...rawArgs) => {
    const args = withBrief(...rawArgs);
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '', failure: result.failure };
  };
  git('init', '-q', '-b', 'main');
  assert.equal(run('init').code, 0);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(BIN, join(root, 'node_modules/.bin/pullboard'));
  appendFileSync(join(root, '.git/info/exclude'), '\nnode_modules/\n');
  put(root, 'SPEC.md', SPEC);
  put(root, 'package.json', '{"type":"module"}\n');
  return { dir, root, env, git, run };
}

/** Add items with the criterion, route and brief the board now requires; every other move passes through. */
export function withBrief(...args) {
  if (args[0] !== 'add' || args.includes('--route')) return args;
  const filled = args.includes('--criterion') ? [] : ['--criterion', 'The fixture item is valid.'];
  if (!args.includes('--check')) return [...args, ...filled, '--route', 'strong'];
  return [...args, ...filled, '--route', 'mid', '--brief', 'Files: src/fixture.js\nChange: keep the fixture valid\nTest: the fixture check passes'];
}

/** Create a real joined builder with its accepted fixture ownership before any claim. */
export function builderRepo(box, additionalOwned = []) {
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { build: { owns: ['src/', 'test/', ...additionalOwned], specs: ['G'] } };
  put(box.root, 'pullboard.json', JSON.stringify(config));
  commitAll(box);
  // Joining declares a model (MODEL_REQUIRED); a fixture builder names its own rather than inheriting the host's.
  box.env.PULLBOARD_MODEL ??= 'fixture-model';
  const made = box.run('worktree', 'build', '--json');
  assert.equal(made.code, 0, made.err);
  const root = JSON.parse(made.out).path;
  /** Run Git only in the joined builder. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  /** Run the real CLI with the joined builder identity. */
  const run = (...rawArgs) => {
    const args = withBrief(...rawArgs);
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env: box.env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '', failure: result.failure };
  };
  const coordinator = (...args) => box.run(...withBrief(...args));
  return { ...box, root, git, run, coordinator };
}

/** Write a fixture file, creating its parent directory when needed. */
export function put(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Commit the fixture state using a valid Pullboard message. */
export function commitAll(box, message = 'chore: fixture state') {
  box.git('add', '-A');
  box.git('commit', '-q', '-m', message);
  return box.git('rev-parse', 'HEAD');
}

/** Seed a small import graph with three independently discoverable test files. */
export function seedGraph(box) {
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'src/middle.js', "export { value } from './a.js';\n");
  put(box.root, 'src/entry.js', "export const load = () => import('./middle.js');\n");
  put(box.root, 'src/other.js', 'export const other = true;\n');
  put(box.root, 'test/a.test.js', "import '../src/entry.js';\n");
  put(box.root, 'test/b.test.js', "import '../src/other.js';\n");
  put(box.root, 'test/c.test.js', "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  return commitAll(box);
}
