import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, reportFixtureChildFailure, runFixtureChild, runFixtureGit } from './fixture-child.js';
import { performance } from 'node:perf_hooks';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import * as store from '../src/board.js';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../src/person.js';
import { fetchFresh } from './http-fixture.js';
import { fetchPrintedViewLink } from './view-link-fixture.js';

/** Create isolated real-repository helpers for one parallel end-to-end test file. */
export function createE2eHelpers() {
  const sandboxes = [];
  /** Remove this test file's fixtures after its tests finish. */
  const cleanup = () => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  };
const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const cockpitSource = () => readFileSync(resolve(import.meta.dirname, '../src/cockpit.js'), 'utf8');
/**
 * A scratch directory with a `pullboard` shim on the PATH, so the hooks git runs find the CLI, and
 * git isolated from the machine's own config.
 */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-e2e-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  delete env.PULLBOARD_RELAY_TOKEN;
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const tryGit = (cwd, ...args) => runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  const run = (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  };
  return { dir, env, git, tryGit, run };
}

const CONFIG = {
  gate: 'test ! -f RED',
  spec: 'SPEC.md',
  verify: 'any',
  lease: '2h',
  lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  shared: ['docs/'],
};

const SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The API answers. | gate: api test
`;

/**
 * A repo set up with pullboard, two lanes and a spec, committed through its own hooks, plus a
 * worktree joined to the web lane. The coordinator stays deliberately undeclared; later agents
 * retain the runner's model, while initialization model coverage invokes init directly.
 * Coordinator-only fixtures may omit the unused worktree and its join.
 */
function project(gate = CONFIG.gate, box = sandbox(), { separateGitDir = false, withWorktree = true } = {}) {
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main', ...(separateGitDir ? ['--separate-git-dir', join(box.dir, 'separate-git')] : []));
  const inheritedModel = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  assert.equal(box.run(repo, 'init').code, 0);
  if (inheritedModel !== undefined) box.env.PULLBOARD_MODEL = inheritedModel;
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  if (!withWorktree) return { ...box, repo };
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  assert.match(box.run(web, 'join', 'web').out, /joined as web-1/);
  return { ...box, repo, web };
}

/** Create a private gate that waits only after the test arms it. */
function holdingGate(box) {
  const script = join(box.dir, 'holding-gate.cjs');
  const mode = join(box.dir, 'hold-gate');
  const release = join(box.dir, 'release-gate');
  const events = join(box.dir, 'gate-events.log');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    'const [armed, release, events] = process.argv.slice(2);',
    'if (!fs.existsSync(armed)) process.exit(0);',
    "fs.appendFileSync(events, 'start\\n');",
    'const deadline = Date.now() + 15000;',
    'while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
    'if (!fs.existsSync(release)) process.exit(23);',
    "fs.appendFileSync(events, 'end\\n');",
  ].join('\n'));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return { command: `node ${quote(script)} ${quote(mode)} ${quote(release)} ${quote(events)}`, mode, release, events };
}

/** Launch a CLI or Git process while preserving its output for the gate-lock assertion. */
function launch(box, cwd, command, args) {
  const startedAt = performance.now();
  const child = spawn(command, args, { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { child.stdoutText += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.stderrText += chunk; });
  child.closed = new Promise((resolveClose) => {
    let reported = false;
    const reportFailure = (code, signal, extra = '') => {
      if (reported) return;
      reported = true;
      child.failure = reportFixtureChildFailure({ command, args, status: code, signal,
        elapsedMs: performance.now() - startedAt, stderr: child.stderrText, env: box.env, detail: extra });
    };
    child.once('error', (error) => reportFailure(null, null, error.message));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal) reportFailure(code, signal);
      resolveClose({ code, signal, failure: child.failure ?? null });
    });
  });
  return child;
}

/** Wait for a private fixture observation with a bounded failure time. */
async function waitFor(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Read the private gate event sequence without exposing arbitrary gate output. */
function gateEvents(gate) {
  return existsSync(gate.events) ? readFileSync(gate.events, 'utf8').trim().split(/\r?\n/u).filter(Boolean) : [];
}

/**
 * Write a file in a worktree and commit it, returning git's result so a refusal can be read.
 */
function commitFile(box, cwd, path, text, message) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), text);
  box.git(cwd, 'add', '-A');
  return box.tryGit(cwd, 'commit', '-q', '-m', message);
}

const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

async function startView(box, cwd) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0'], { cwd, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' } });
  const link = await new Promise((found, fail) => {
    let out = '';
    let stderr = '';
    let settled = false;
    const rejectStartup = (code, signal, extra = '') => {
      if (settled) return;
      settled = true;
      const failure = reportFixtureChildFailure({ command: process.execPath, args: [BIN, 'view', '--no-open', '--port', '0'],
        status: code, signal, elapsedMs: performance.now() - startedAt, stderr, env: box.env, detail: extra });
      fail(new Error(failure));
    };
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(out);
      if (match && !settled) { settled = true; found(new URL(match[1])); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => rejectStartup(null, null, error.message));
    child.once('exit', (code, signal) => rejectStartup(code, signal));
  });
  const key = link.searchParams.get('k');
  const base = `http://127.0.0.1:${link.port}`;
  const headers = { 'x-pullboard-key': key };
  /** Read the page through either the legacy link or the cookie exchange. */
  const page = () => fetchPrintedViewLink(link);
  /** Read the public listing through the view's real authenticated API. */
  const boards = async () => {
    const response = await fetchFresh(`${base}/api/v1/boards`, { headers });
    return { status: response.status, document: await response.json() };
  };
  /** Resolve a registered board id and read full public state for test ground truth. */
  const state = async (root) => {
    const listing = await boards();
    if (listing.status !== 200) return listing;
    const board = listing.document.boards.find((entry) => entry.root === root);
    if (!board) return { ...listing.document, project: null };
    const response = await fetchFresh(`${base}/api/v1/boards/${encodeURIComponent(board.id)}/state?detail=full`, { headers });
    return { ...listing.document, project: (await response.json()).state };
  };
  /** Send a public move to the registered board or a deliberately unknown id. */
  const act = async (root, body) => {
    const listing = await boards();
    const board = listing.document.boards?.find((entry) => entry.root === root);
    const id = board?.id ?? '0'.repeat(32);
    const response = await fetchFresh(`${base}/api/v1/boards/${encodeURIComponent(id)}/moves`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, document: await response.json() };
  };
  const stop = () => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
  });
  return { link, key, base, page, state, act, stop };
}

function attackCommit(box, cwd) {
  box.git(cwd, 'add', '-A');
  const tree = box.git(cwd, 'write-tree');
  const commit = box.git(cwd, 'commit-tree', tree, '-p', 'HEAD', '-m', 'feat(web): adversarial fixture [G1]');
  box.git(cwd, 'update-ref', 'HEAD', commit);
  return commit;
}

/** Seed a legacy receipt from the old full-gate-only submit rule, for independent verifier audits. */
function historicalCheckSubmission(box, commit) {
  box.git(box.web, 'update-ref', `refs/pullboard/items/1/${commit.slice(0, 12)}`, commit);
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', `${commit}^{tree}`) }); }
  finally { store.closeBoard(board); }
}

/** Retain historical submissions whose private check needs an install, fails, or times out. */
function privateCheckSubmission({ install = '', timeout = '5m', check }) {
  const box = project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.check = { install, timeout };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private check fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.repo, 'add', 'web', 'Private check', '--specs', 'G1', '--criterion', 'the installed check passes', '--check', check).code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/.gitignore'), '.deps/\n');
  writeFileSync(join(box.web, 'web/index.html'), 'fixture');
  const commit = attackCommit(box, box.web);
  historicalCheckSubmission(box, commit);
  const review = join(box.dir, 'private-check-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(box.run(review, 'join', 'api').code, 0);
  return { ...box, review, commit };
}


  return {
    BIN, cockpitSource, sandboxes, cleanup, sandbox, CONFIG, SPEC, project,
    holdingGate, launch, waitFor, gateEvents, commitFile, attackCommit, historicalCheckSubmission, privateCheckSubmission,
    startView, LIGHT_BRIEF,
  };
}
