/** Chrome-free scratch machine and project fixtures, shared by cockpit and non-browser tests [C7,O5]. */
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  appendFileSync,
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
import { DatabaseSync } from 'node:sqlite';
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
  fixtureSettledMachine,
  joinFixtureSeat,
} from '../testkit.js';
import {
  parityRecord,
  journeyCall,
  withoutPullboardEnv,
} from '../e2e.js';
import { runCliInProcess } from '../process.js';
import { commitInProcess } from '../hook/commit.js';
import { inProcessHooksOn } from '../hook/mode.js';
import { reviveFixtureLocalRunner } from '../runner/local-start.js';
import { stopFixtureLocalRunner } from '../runner/local-stop.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');
const scratch = [];
/** Commands that can offer a pulled job (a gate, a land) the machine's loopback local runner takes. */
const JOB_OFFERING = new Set(['submit', 'verify', 'land', 'accept', 'test', 'ship', 'resubmit', 'run']);
/** Budget: how long a fixture command waits for the loopback local runner to finish the jobs it offered. */
const SETTLE_MS = 180_000;
/** Budget: how long a settled submit's item may still read claimed while its gate verdict is applied. */
const SUBMIT_GRACE_MS = 8_000;
/** The model later agent commands run under; init and the exposed env carry none, as a scratch machine has no seat identity [C7,N26]. */
const MACHINE_MODEL = 'Test Model';

after(() => {
  for (const dir of scratch) stopFixtureLocalRunner(join(dir, 'machine-home'));
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 });
});

const SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The page says goodbye. | gate: web test
`;

/**
 * Tell a fixture `add` that its item differs from any open one, in place, and return args.
 * Why: fixture items share bare titles and criteria, so the duplicate guard refuses most of them; each one is a separate case, never a repeat [C7].
 */
function fixtureAddDistinct(args) {
  if (args[0] === 'add' && !args.some(arg => arg === '--not-duplicate-of' || arg.startsWith('--not-duplicate-of='))) args.push('--not-duplicate-of', '1 each fixture item is a separate case');
  return args;
}

/**
 * Append one parity record for a finished CLI call when PULLBOARD_PARITY_RECORD is set, and write nothing otherwise.
 * Why: the real-process and in-process modes of the box must be comparable call by call, by the same record shape the other boxes write [C7,U149].
 *
 * @param {{ dir: string, env: object, cwd: string, args: string[], result: { status: number, stdout: string, stderr: string } }} call The finished call.
 * @returns {void}
 */
function recordParity({ dir, env, cwd, args, result }) {
  if (!process.env.PULLBOARD_PARITY_RECORD) return;
  appendFileSync(process.env.PULLBOARD_PARITY_RECORD, `${JSON.stringify(parityRecord({ dir, env, cwd, args, result: { code: result.status, out: result.stdout, stderr: result.stderr } }))}\n`);
}

/**
 * Wait until the board `cwd` belongs to holds no unfinished runner job, so a cockpit journey reads a settled gate or landing.
 * Why: under pull dispatch a submit offers its gate as a job the loopback local runner takes and returns at once; the
 * journeys read what the gate decided, so run() and inProcess() return once the queue is done and keep returning stdout,
 * the shape every harness.js importer reads [P7,C7,#5821].
 *
 * @param {string} cwd - Where the command ran.
 * @param {string[]} args - The command's arguments.
 * @param {object} env - The command's environment.
 * @returns {void}
 */
function settleOfferedJobs(cwd, args, env) {
  if (!JOB_OFFERING.has(args[0]) || args.includes('--help') || args.includes('--status') || args.includes('--cancel')) return;
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env, encoding: 'utf8' });
  if (common.status !== 0) return;
  const file = join(common.stdout.trim(), 'pullboard', 'board.sqlite');
  if (!existsSync(file)) return;
  const deadline = Date.now() + SETTLE_MS;
  // A receipt marks its job done in one transaction and the gate's verdict reaches the item just after, so a submit's item
  // is read again for a short grace once the queue is empty: a gate that sent it back leaves it claimed, and that is the answer.
  const submitted = args[0] === 'submit' && /^\d+$/u.test(args[1] ?? '') ? Number(args[1]) : null;
  let graceUntil = 0;
  for (;;) {
    let open = false;
    // @pullboard-board-file journey: a read-only look at the job queue the real CLI wrote.
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        // A review job is a reviewer's reservation that stays open until a verdict, never work a runner takes (next --verify, 7 Nov: bb9a8cfcd2).
        open = Boolean(db.prepare("SELECT 1 FROM job WHERE job_step <> 'done' AND job_kind <> 'review' LIMIT 1").get());
        if (!open && submitted !== null) {
          if (!graceUntil) graceUntil = Date.now() + SUBMIT_GRACE_MS;
          open = db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(submitted)?.item_status === 'claimed' && Date.now() < graceUntil;
        }
      } finally { db.close(); }
    } catch (error) { if (/unable to open|no such table/u.test(String(error?.message))) return; open = true; }
    if (!open || Date.now() >= deadline) return;
    // A command that offers a job without starting a runner (a verify, a land) still has one to take it.
    reviveFixtureLocalRunner(cwd, env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

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
    // A nested pullboard test in a fixture board skips the machine's load wait (#7257,#7263).
    PULLBOARD_FIXTURE_BOARD: '1',
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    // The loopback local runner a pull submit starts stops with this test process, never outliving the journey [P7].
    ...(process.env.PULLBOARD_TEST_RUNNER_PID ? { PULLBOARD_TEST_RUNNER_PID: process.env.PULLBOARD_TEST_RUNNER_PID } : {}),
  };
  // A cockpit journey's gate runs as a pulled job on the machine's loopback local runner; run() waits for it [P7,#5821].
  fixtureSettledMachine(env.PULLBOARD_MACHINE_HOME);
  // The background opt-out merges into those settings, so it goes second.
  disableFixtureBackgroundView(env, dir);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** git that reports its status: tryGit answers synchronously with real git, so a caller reads `.status` straight away, whatever test.inProcessHooks says [C7,#12659]. */
  const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  /** With test.inProcessHooks on, a plain `commit -m` runs both hooks in this process and answers with a promise, so only a caller that awaits asks for it [C7,#9215]. */
  const tryGitInProcess = (cwd, ...args) => (inProcessHooksOn(env) ? commitInProcess({ env }, cwd, args) : null) ?? tryGit(cwd, ...args);
  const invocations = [];
  /** Run the CLI with an explicit environment and retain facts used by fixture checks. */
  const runWithEnv = (cwd, commandEnv, ...args) => {
    fixtureJoinRoute(args, commandEnv.PULLBOARD_MODEL);
    fixtureAddRoute(args);
    fixtureAddDistinct(args);
    invocations.push({ args, hasModel: Object.hasOwn(commandEnv, 'PULLBOARD_MODEL'), model: commandEnv.PULLBOARD_MODEL });
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env: commandEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}${result.stdout}`);
    settleOfferedJobs(cwd, args, commandEnv);
    recordParity({ dir, env: commandEnv, cwd, args, result });
    return result.stdout;
  };
  /** Await the same CLI call in this process, refusing a non-zero status like runWithEnv, without a launch [C7]. */
  const inProcessWithEnv = async (cwd, commandEnv, ...args) => {
    fixtureJoinRoute(args, commandEnv.PULLBOARD_MODEL);
    fixtureAddRoute(args);
    fixtureAddDistinct(args);
    invocations.push({ args, hasModel: Object.hasOwn(commandEnv, 'PULLBOARD_MODEL'), model: commandEnv.PULLBOARD_MODEL });
    const result = await runCliInProcess(args, { cwd, env: commandEnv });
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}${result.stdout}`);
    settleOfferedJobs(cwd, args, commandEnv);
    recordParity({ dir, env: commandEnv, cwd, args, result });
    return result.stdout;
  };
  /**
   * Await a CLI call in this process without waiting for the jobs it offered, so several submits' gates run on the
   * runner together; settled() then waits once. Why: each submit's gate cost 7 to 20 s on its own, and a journey that
   * seeds several submitted items paid them one after another.
   */
  const inProcessQueued = async (cwd, ...args) => {
    fixtureJoinRoute(args, MACHINE_MODEL);
    invocations.push({ args, hasModel: true, model: MACHINE_MODEL });
    const result = await runCliInProcess(args, { cwd, env: { ...env, PULLBOARD_MODEL: MACHINE_MODEL } });
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}${result.stdout}`);
    recordParity({ dir, env: { ...env, PULLBOARD_MODEL: MACHINE_MODEL }, cwd, args, result });
    return result.stdout;
  };
  /**
   * The journey's call, awaited: in this process by default, a real process under PULLBOARD_JOURNEY_MODE=process, and
   * appended to PULLBOARD_PARITY_RECORD when the parity check asks. Refuses a non-zero status like run, returns stdout, and
   * settles the jobs the call offered in both modes, so the record holds the settled board [C7,U149].
   */
  const runIn = async (cwd, ...args) => {
    const commandEnv = { ...env, PULLBOARD_MODEL: MACHINE_MODEL };
    const prepared = () => {
      const call = [...args];
      fixtureJoinRoute(call, MACHINE_MODEL);
      fixtureAddRoute(call);
      fixtureAddDistinct(call);
      invocations.push({ args: call, hasModel: true, model: MACHINE_MODEL });
      return call;
    };
    const answer = (result, call) => { settleOfferedJobs(cwd, call, commandEnv); return { status: result.status, stdout: result.stdout, stderr: result.stderr }; };
    const result = await journeyCall({ dir, env: commandEnv, cwd, args: [...args], bin: BIN,
      inProcess: async () => { const call = prepared(); return answer(await runCliInProcess(call, { cwd, env: commandEnv }), call); },
      real: () => { const call = prepared(); return answer(spawnSync(process.execPath, [BIN, ...call], { cwd, env: commandEnv, encoding: 'utf8' }), call); } });
    assert.equal(result.status, 0, `pullboard ${args.join(' ')}: ${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  /** Wait until the board `cwd` belongs to has settled the gate of submitted item `id`, as a settled submit would. */
  const settled = (cwd, id) => settleOfferedJobs(cwd, ['submit', String(id)], { ...env, PULLBOARD_MODEL: MACHINE_MODEL });
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
  return { dir, env, git, tryGit, tryGitInProcess, run, runIn, inProcess, inProcessQueued, settled, runWithEnv, invocations, exportSnapshot };
}

/**
 * A project registered on the machine: a repo set up by `pullboard init`, one web lane, and a
 * worktree joined to it as web-1. `extra` adds to its pullboard.json, such as products.
 * `plumbing` makes the setup commit with git plumbing, which runs no hook, for a case that does not prove hook behaviour [C7,#8362].
 * `bare` stops once the board is registered and configured: no setup commit, no worktree, no seat. Why: a board the
 * case only lists in its sidebar or breaks on purpose costs a hook commit (7 to 8 s) it never reads [C7,#8366].
 */
function project(box, name, spec = SPEC, extra = {}, { agentApproved = false, joinSeat = true, bare = false, plumbing = false } = {}) {
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
  // Accepted items stay verified until the journey lands them: the loopback local runner would otherwise take the board's
  // automatic land job and land them into this checkout, as no controller-held fixture ever did [P7,#5821].
  const config = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G'] } }, shared: [], landing: { manualOverride: true }, ...extra };
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), spec);
  if (bare) return { repo, web: null, branch: null, baseBranch: null, itemBranches: new Map() };
  box.git(repo, 'add', '-A');
  if (plumbing) {
    // Git plumbing runs no hook: this commit is setup, and the pre-commit and commit-msg hooks each launched a Node child (#8362).
    box.git(repo, 'update-ref', 'HEAD', box.git(repo, 'commit-tree', box.git(repo, 'write-tree'), '-m', 'chore: set up pullboard'));
  } else box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  const branch = `web/${name.replace(/[^a-z]/g, '')}`;
  const web = join(box.dir, `${name}-web`);
  box.git(repo, 'worktree', 'add', '-q', web, '-b', branch);
  // The seat joins on the strong route so it can claim the strong fixture items.
  if (joinSeat) joinFixtureSeat(box, web, 'web', { model: MACHINE_MODEL });
  return { repo, web, branch, baseBranch: branch, itemBranches: new Map() };
}

export { BIN, scratch, SPEC, MACHINE_MODEL, machine, project };
