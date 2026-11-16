/** The shared real-CLI fixtures for the submit gate: a private repository, a joined builder and a small import graph [V4,C7,V16]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from '../child.js';
import { runFixtureGit } from '../child.js';
import { fixtureSettledMachine } from '../testkit.js';
import { JOURNEY_MODE } from '../e2e.js';
import { parityRecord } from '../e2e.js';
import { runCliSync } from '../sync/cli.js';
import { stopFixtureLocalRunner } from '../runner/local-stop.js';
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

// Calls that settle pulled jobs or can outlast the worker thread's 45 s wait stay real processes [C7].
const REAL_COMMANDS = new Set(['submit', 'verify', 'land', 'test', 'gate']);

/**
 * One fixture CLI call: answered by the warm worker thread, or a real process for a heavy command or under PULLBOARD_JOURNEY_MODE=process.
 * Why: a Node start-up per setup call is most of a gate journey's fixture time; the parity record lets the gate compare both ways (U149) [C7].
 *
 * @param {{ dir: string, cwd: string, env: object }} where - The fixture folder, directory and environment.
 * @param {string[]} args - The command and its flags, already filled by withBrief.
 * @returns {{ code: number, out: string, err: string, failure: unknown }} The answer in the shape of `box.run`.
 */
function fixtureCall({ dir, cwd, env }, args) {
  const quick = JOURNEY_MODE !== 'process' && !REAL_COMMANDS.has(args[0]);
  const result = quick ? runCliSync(args, { cwd, env })
    : runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  if (process.env.PULLBOARD_PARITY_RECORD) {
    const answer = { code: result.status, out: result.stdout ?? '', stderr: result.stderr ?? '' };
    appendFileSync(process.env.PULLBOARD_PARITY_RECORD, `${JSON.stringify(parityRecord({ dir, env, cwd, args, result: answer }))}\n`);
  }
  return { code: result.status, out: result.stdout ?? '', err: result.failure ?? result.stderr ?? '', failure: result.failure ?? null };
}

/** Create a private Git repository with a deterministic identity and isolated Pullboard home. */
export function privateRepo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-submit-gate-')));
  dirs.push(dir);
  // The machine's local runner stops before the folder goes: after hooks run in the order they were added, so a runner a
  // later submit started still heartbeat into this folder while it was removed, and rmdir failed ENOTEMPTY [#7530].
  t.after(() => { stopFixtureLocalRunner(join(dir, 'machine-home')); rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); });
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
    PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  delete env.PULLBOARD_RELAY_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  // These submits settle the same way whatever the machine's dispatch default is [P7].
  fixtureSettledMachine(env.PULLBOARD_MACHINE_HOME);
  /** Run real Git in this fixture with only the fixture's configured identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Run the real local CLI, retaining JSON stdout and refusal stderr separately. */
  const run = (...rawArgs) => {
    return fixtureCall({ dir, cwd: root, env }, withBrief(...rawArgs));
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
export function builderRepo(box, additionalOwned = [], { plumbing = false } = {}) {
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.lanes = { build: { owns: ['src/', 'test/', ...additionalOwned], specs: ['G'] } };
  put(box.root, 'pullboard.json', JSON.stringify(config));
  commitAll(box, 'chore: fixture state', plumbing);
  // Joining declares a model (MODEL_REQUIRED); a fixture builder names its own rather than inheriting the host's.
  box.env.PULLBOARD_MODEL ??= 'fixture-model';
  const made = box.run('worktree', 'build', '--json');
  assert.equal(made.code, 0, made.err);
  const root = JSON.parse(made.out).path;
  /** Run Git only in the joined builder. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env: box.env });
  /** Run the real CLI with the joined builder identity. */
  const run = (...rawArgs) => {
    return fixtureCall({ dir: box.dir, cwd: root, env: box.env }, withBrief(...rawArgs));
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

/**
 * Commit the fixture state using a valid Pullboard message.
 * Why plumbing: a hooked commit launches node hooks (about 5 s loaded); a journey that does not prove hook behaviour writes setup commits without them [C7].
 *
 * @param {{ git: Function }} box - A fixture box.
 * @param {string} [message] - The commit message.
 * @param {boolean} [plumbing] - Write the commit with Git plumbing, so no hook runs.
 * @returns {string} The new HEAD.
 */
export function commitAll(box, message = 'chore: fixture state', plumbing = false) {
  box.git('add', '-A');
  if (!plumbing) {
    box.git('commit', '-q', '-m', message);
    return box.git('rev-parse', 'HEAD');
  }
  const tree = box.git('write-tree');
  let parent = [];
  try { parent = ['-p', box.git('rev-parse', '--verify', '-q', 'HEAD')]; } catch { /* the first commit has no parent */ }
  const commit = box.git('commit-tree', tree, ...parent, '-m', message);
  box.git('update-ref', 'HEAD', commit);
  return commit;
}

/** Seed a small import graph with three independently discoverable test files. */
export function seedGraph(box, plumbing = false) {
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'src/middle.js', "export { value } from './a.js';\n");
  put(box.root, 'src/entry.js', "export const load = () => import('./middle.js');\n");
  put(box.root, 'src/other.js', 'export const other = true;\n');
  put(box.root, 'test/a.test.js', "import '../src/entry.js';\n");
  put(box.root, 'test/b.test.js', "import '../src/other.js';\n");
  put(box.root, 'test/c.test.js', "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  return commitAll(box, 'chore: fixture state', plumbing);
}
