/** Chrome-free scratch machine and project fixtures, shared by cockpit and non-browser tests [C7,O5]. */
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
  sep,
} from 'node:path';
import { after } from 'node:test';
import { disableFixtureBackgroundView } from './view.js';
import {
  fixtureAddRoute,
  fixtureJoinRoute,
  fixtureMachineSettings,
  joinFixtureSeat,
} from '../testkit.js';
import { withoutPullboardEnv } from '../e2e.js';
import { runCliInProcess } from '../process.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');
const scratch = [];
/** The model later agent commands run under; init and the exposed env carry none, as a scratch machine has no seat identity [C7,N26]. */
const MACHINE_MODEL = 'Test Model';

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The page says goodbye. | gate: web test
`;

/**
 * A scratch machine: its own project registry, a `pullboard` shim on the PATH so the hooks find the
 * CLI, and git kept apart from this machine's config. run() fails the test on any refusal.
 */
function machine() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-cockpit-')));
  scratch.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(dir, 'bin', 'pullboard'), 0o755);
  const env = {
    ...withoutPullboardEnv(process.env),
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  disableFixtureBackgroundView(env, dir);
  // Cockpit journeys hold their gate in the submitting process, so they pin controller dispatch like e2e.js does [P7].
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const invocations = [];
  /** Run the CLI with an explicit environment and retain facts used by fixture checks. */
  const runWithEnv = (cwd, commandEnv, ...args) => {
    fixtureJoinRoute(args, commandEnv.PULLBOARD_MODEL);
    fixtureAddRoute(args);
    invocations.push({ args, hasModel: Object.hasOwn(commandEnv, 'PULLBOARD_MODEL'), model: commandEnv.PULLBOARD_MODEL });
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env: commandEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  /** Await the same CLI call in this process, refusing a non-zero status like runWithEnv, without a launch [C7]. */
  const inProcessWithEnv = async (cwd, commandEnv, ...args) => {
    fixtureJoinRoute(args, commandEnv.PULLBOARD_MODEL);
    fixtureAddRoute(args);
    invocations.push({ args, hasModel: Object.hasOwn(commandEnv, 'PULLBOARD_MODEL'), model: commandEnv.PULLBOARD_MODEL });
    const result = await runCliInProcess(args, { cwd, env: commandEnv });
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  /** Run the CLI with the machine environment used by later agent commands. */
  const run = (cwd, ...args) => runWithEnv(cwd, { ...env, PULLBOARD_MODEL: MACHINE_MODEL }, ...args);
  /** The in-process twin of run: await it. */
  const inProcess = (cwd, ...args) => inProcessWithEnv(cwd, { ...env, PULLBOARD_MODEL: MACHINE_MODEL }, ...args);
  /** Produce a fresh private snapshot through the actual CLI; no existing or caller-supplied root is adopted. */
  function exportSnapshot(cwd, leaf) {
    assert.match(leaf, /^[A-Za-z0-9][A-Za-z0-9_-]*$/u, 'snapshot output has one private leaf');
    assert.ok(realpathSync(cwd).startsWith(dir + sep), 'snapshot project belongs to this actual machine');
    const root = join(dir, leaf);
    assert.ok(!existsSync(root), 'snapshot output is fresh, never an adopted directory');
    run(cwd, 'view', '--export', root);
    const exported = lstatSync(root);
    assert.ok(exported.isDirectory() && !exported.isSymbolicLink() && realpathSync(root) === root,
      'the actual export produced its private directory');
    /** Read actual post-export bytes, preserving every Buffer and refusing unknown or escaping paths. */
    function readFile(file) {
      assert.equal(typeof file, 'string', 'snapshot file is explicit');
      assert.ok(file.startsWith(root + sep) && !file.slice(root.length + 1).split(sep).some(part => !part || part === '.' || part === '..'),
        'snapshot file belongs to this output');
      const stat = lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && realpathSync(file).startsWith(root + sep),
        'snapshot file is an actual contained regular file');
      return readFileSync(file);
    }
    /** Include every recursive file and extension; unexpected subtrees never disappear from privacy assertions. */
    function files() {
      /** Refuse symbolic directories instead of following or silently skipping them. */
      function visit(directory) {
        const stat = lstatSync(directory);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (directory === root || realpathSync(directory).startsWith(root + sep)),
          'snapshot traversal stays in its actual output');
        return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
          const file = join(directory, entry.name);
          return entry.isDirectory() ? visit(file) : [{ file, body: readFile(file) }];
        });
      }
      return visit(root);
    }
    return Object.freeze({ root, readFile, files });
  }
  return { dir, env, git, run, inProcess, runWithEnv, invocations, exportSnapshot };
}

/**
 * A project registered on the machine: a repo set up by `pullboard init`, one web lane, and a
 * worktree joined to it as web-1. `extra` adds to its pullboard.json, such as products.
 */
function project(box, name, spec = SPEC, extra = {}, { agentApproved = false, joinSeat = true } = {}) {
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initEnv = { ...box.env };
  delete initEnv.PULLBOARD_MODEL;
  // Set the fixture-only opt-out in the machine home that this exact init environment will use.
  disableFixtureBackgroundView(initEnv, box.dir);
  // The spec is in place before init, so the board's approval baseline holds its approved rows as the person's (#960);
  // agentApproved writes it after init instead, so its approved rows read as an agent's.
  if (!agentApproved) writeFileSync(join(repo, 'SPEC.md'), spec);
  box.runWithEnv(repo, initEnv, 'init');
  const config = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] } }, shared: [], ...extra };
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), spec);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  const branch = `web/${name.replace(/[^a-z]/g, '')}`;
  const web = join(box.dir, `${name}-web`);
  box.git(repo, 'worktree', 'add', '-q', web, '-b', branch);
  // The seat joins on the strong route so it can claim the strong fixture items.
  if (joinSeat) joinFixtureSeat(box, web, 'web', { model: MACHINE_MODEL });
  return { repo, web, branch, baseBranch: branch, itemBranches: new Map() };
}

export { BIN, scratch, SPEC, MACHINE_MODEL, machine, project };
