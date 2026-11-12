/** Shared fixtures for the check-baseline journeys: private projects, a stand-in runner and replica boards [V2,H3,H16]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from './child.js';
import { runFixtureGit } from './child.js';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { runCliInProcess } from './process.js';
import { closeBoard } from '../../../lib/index.js';
import { openBoard } from '../../../lib/index.js';
import { FIXTURE_MODEL } from './e2e.js';
import {
  HOST,
  installSshStandIn,
} from './runner/ssh.js';

export const BIN = resolve(import.meta.dirname, '../../pullboard.js');
export const BOARD_FILE = '.git/pullboard/board.sqlite';
const TEMP_DIRS = [];
const SPEC = `# Check baseline fixture\n\n## G · Goals\n- G1 [approved, must] The fixture keeps its board. | gate: true\n`;
/** Remove each private fixture after node:test has stopped its child processes. */
export function cleanupFixtures() {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

/** Quote one shell word without allowing fixture paths or source to become syntax. */
export function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Create private Git, CLI and machine-home settings without inheriting repository selectors. */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-check-baseline-'));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Check baseline fixture',
    GIT_AUTHOR_EMAIL: 'check-baseline@example.invalid',
    GIT_COMMITTER_NAME: 'Check baseline fixture',
    GIT_COMMITTER_EMAIL: 'check-baseline@example.invalid',
  });
  /** Run Git with only this fixture's config and identity. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env });
  }
  /** Run a real pullboard CLI process with optional stdin. */
  function run(cwd, args, input, options = {}) {
    return runFixtureChild(process.execPath, [BIN, ...args], {
      cwd, env, encoding: 'utf8',
      ...(input === undefined ? {} : { input }), ...options,
    });
  }
  /** The same call as run, answered by the production dispatcher in this process (no node start-up); it reads the box env at call time. */
  async function runLocal(cwd, args, input) {
    return runCliInProcess(args, { cwd, env, ...(input === undefined ? {} : { input }) });
  }
  return { dir, env, git, run, runLocal };
}

/**
 * Register the SSH stand-in as the box's one runner, so the background baseline has a runner to run on.
 * Why: a check baseline runs only on a registered runner (#2520); without one add leaves it pending forever.
 */
export function registerRunner(box) {
  const bin = join(box.dir, 'ssh-bin');
  const worker = join(box.dir, 'worker');
  const remoteHome = join(box.dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  for (const folder of [bin, worker, remoteHome, remoteMachineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests: join(box.dir, 'ssh-requests.jsonl') });
  box.env.PATH = bin + ':' + box.env.PATH;
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  assert.equal(box.run(box.repo, ['runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json']).status, 0);
  assert.equal(box.run(box.repo, ['settings', 'gate.loadAwareDispatch', 'off', '--json']).status, 0);
  // The stand-in is a push runner; its baselines go through the controller's gate slot, not the pull queue (#6249).
  assert.equal(box.run(box.repo, ['settings', 'gate.runnerDispatch', 'controller', '--json']).status, 0);
  return worker;
}

/**
 * Initialize an isolated repo and optional real web/review worktrees. Fixtures keep init's
 * checks.provesNothing hold only when asked: the other tests here prove today's warning, which a
 * board with no setting keeps.
 */
export function project({ gate = 'true', content = 'green', commit = true, worktrees = false, hold = false } = {}) {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'result.txt'), `${content}\n`);
  const initialized = box.run(repo, ['init']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const configFile = join(repo, 'pullboard.json');
  const { checks, ...config } = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, `${JSON.stringify({
    ...config,
    ...(hold ? { checks } : {}),
    gate,
    spec: 'SPEC.md',
    lanes: {
      web: { owns: ['web/'], specs: ['G1'] },
      review: { owns: [], specs: ['G1'] },
    },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  if (commit) {
    box.git(repo, 'add', '-A');
    box.git(repo, 'commit', '-q', '-m', 'chore: set up check baseline fixture');
  }
  const fixture = { ...box, repo, web: null, review: null, initChecks: checks, worker: commit ? registerRunner({ ...box, repo }) : null };
  if (worktrees) {
    fixture.web = addWorktree(fixture, 'web', 'web/agent');
    fixture.review = addWorktree(fixture, 'review', 'review/agent');
  }
  return fixture;
}

/** Create and join one real worktree for the requested fixture lane. */
export function addWorktree(box, lane, branch) {
  const path = join(box.dir, lane);
  box.git(box.repo, 'worktree', 'add', '-q', path, '-b', branch);
  const joined = box.run(path, ['join', lane, '--model', FIXTURE_MODEL, '--route', 'strong']);
  assert.equal(joined.status, 0, joined.stderr);
  return path;
}

/** Build a command that records its execution location and checks one tracked value. */
export function fileCheck(expected, marker = 'check-marker.txt', observations = null) {
  const script = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    ...(observations ? [`fs.appendFileSync(${JSON.stringify(observations)}, process.cwd() + '\\n');`] : []),
    `process.exit(fs.readFileSync('web/result.txt', 'utf8').trim() === ${JSON.stringify(expected)} ? 0 : 1);`,
  ].join('');
  return `${shellWord(process.execPath)} -e ${shellWord(script)}`;
}

/** Add a check-bearing item as coordinator and return its JSON result and item id. */
export function addChecked(box, title, check) {
  const result = box.run(box.repo, ['add', 'web', title, '--specs', 'G1', '--criterion', 'the check is measured on main', '--check', check, '--wait', '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', 'add writes no baseline diagnostics to stderr');
  return { result, item: JSON.parse(result.stdout).item };
}

/** Read the item's JSON view so tests inspect its public baseline shape. */
export function showItem(box, id, cwd = box.repo) {
  const result = box.run(cwd, ['show', String(id), '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { result, item: JSON.parse(result.stdout) };
}

/** Await an actual fixture state, with a deadline used only to prevent a stranded child. */
export async function waitForState(read, description) {
  const deadline = Date.now() + 30_000;
  while (!read() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
  assert.ok(read(), description);
}

/** Build a check held on a release file; its finite fallback lets a blocking mutant finish red. */
export function heldCheck(box, name) {
  const started = join(box.dir, `${name}-started.json`);
  const finished = join(box.dir, `${name}-finished`);
  const release = join(box.dir, `${name}-release`);
  const script = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({cwd:process.cwd(),content:fs.readFileSync('web/result.txt','utf8').trim()}));`,
    `const until=Date.now()+20000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);`,
    `fs.writeFileSync(${JSON.stringify(finished)},'finished');`,
  ].join('');
  return { started, finished, release, command: `${shellWord(process.execPath)} -e ${shellWord(script)}` };
}

/** Open a board file and always close it after returning a synchronous result. */
export function withBoard(file, callback) {
  const board = openBoard(file);
  try { return callback(board); } finally { closeBoard(board); }
}

/** Apply a captured move in a separate Node process so each replica has its own cwd and env. */
export function applyInReplica(file, replicaDir, moveFile, env, at = '2026-10-07T12:00:00.000Z') {
  const boardUrl = new URL('../../../../packages/store/index.js', import.meta.url).href;
  const engineUrl = new URL('../../../../packages/state/index.js', import.meta.url).href;
  const source = [
    `import { closeBoard } from ${JSON.stringify(boardUrl)};`,
    `import { openBoard } from ${JSON.stringify(new URL('../../../lib/src/logic/native.js', import.meta.url).href)};`,
    `import { applyEngineMove } from ${JSON.stringify(engineUrl)};`,
    "import { readFileSync } from 'node:fs';",
    'const board = openBoard(process.argv[1]);',
    'try { applyEngineMove(board, JSON.parse(readFileSync(process.argv[2], "utf8")), { sequence: Number(process.argv[3]), at: process.argv[4] }); }',
    'finally { closeBoard(board); }',
  ].join('\n');
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', source, file, moveFile, String(env.sequence), at], {
    cwd: replicaDir, env, encoding: 'utf8',
  });
}
