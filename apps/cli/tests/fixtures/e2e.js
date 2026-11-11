import { createHash } from 'node:crypto';
import { submitFixture } from './board/submit.js';
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from './child.js';
import { reportFixtureChildFailure } from './child.js';
import { runFixtureChild } from './child.js';
import { runFixtureGit } from './child.js';
import { performance } from 'node:perf_hooks';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { resolve } from 'node:path';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { fetchFresh } from './http.js';
import { fetchPrintedViewLink } from './view/link.js';
import { fileFixtureItem } from './testkit.js';
import { fixtureAddRoute } from './testkit.js';
import { fixtureJoinRoute } from './testkit.js';
import { joinFixtureSeat } from './testkit.js';

/** The model every fixture board runs as, whatever the parent process was launched with [C7]. */
export const FIXTURE_MODEL = 'fixture-model';

/**
 * A copy of an environment with every PULLBOARD_ variable removed, so a fixture never inherits the
 * agent's identity or home. Each fixture sets the PULLBOARD_ values it needs on top of this copy.
 * @param {Record<string, string | undefined>} source The parent process environment.
 * @returns {Record<string, string | undefined>} A new object without PULLBOARD_ keys.
 */
export function withoutPullboardEnv(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('PULLBOARD_')));
}

/** Create isolated real-repository helpers for one parallel end-to-end test file. */
export function createE2eHelpers() {
  const sandboxes = [];
  /**
   * Remove this test file's fixtures after its tests finish. A detached writer (a gate or board worker a
   * fixture command started) can still be flushing into the tree on a loaded runner, so the removal waits up
   * to 30 s for it to stop; the 1 s budget failed pending-refreeze with ENOTEMPTY (#3192).
   */
  const cleanup = () => {
    for (const dir of sandboxes) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try { rmSync(dir, { recursive: true, force: true }); break; }
        catch (error) {
          if (!['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE'].includes(error.code) || Date.now() >= deadline) throw error;
          // A writer can recreate files after traversal; retry the whole tree, not just the failed rmdir.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(200, deadline - Date.now()));
        }
      }
    }
  };
const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const cockpitSource = () => readFileSync(resolve(import.meta.dirname, '../../src/io/cockpit.js'), 'utf8');

/**
 * A scratch directory with a `pullboard` shim on the PATH, so the hooks git runs find the CLI, and
 * git isolated from the machine's own config.
 */
function sandbox({ declareFamilies = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-e2e-')));
  sandboxes.push(dir);
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...withoutPullboardEnv(process.env),
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    // Fixtures read usage right after a move; the detached checkpoint has its own proof [N2].
    PULLBOARD_USAGE_CHECKPOINT: 'inline',
    // A fixture's infrastructure retry does not wait out the real 30 s back-off (#3365).
    PULLBOARD_INFRA_RETRY_BACKOFF_MS: '0',
    // A fixed fixture model, so no fixture reads the machine's or the agent seat's identity [C7].
    PULLBOARD_MODEL: FIXTURE_MODEL,
  };
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  delete env.PULLBOARD_RELAY_TOKEN;
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const tryGit = (cwd, ...args) => runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  const declaredFamilies = new Map();
  /** Explicit private vendor labels are fixture data, independent of model and parent identity. */
  const declareFamily = (cwd, family) => {
    const value = family ?? `Fixture Vendor ${declaredFamilies.size + 1}`;
    declaredFamilies.set(cwd, value);
    return value;
  };
  const run = (cwd, ...args) => {
    if (declareFamilies && args[0] === 'join') {
      const familyFlag = args.findIndex(arg => arg === '--family' || arg.startsWith('--family='));
      if (familyFlag >= 0) declareFamily(cwd, args[familyFlag].startsWith('--family=') ? args[familyFlag].slice(9) : args[familyFlag + 1]);
      else if (!declaredFamilies.has(cwd)) args.push('--family', declareFamily(cwd));
    }
    fixtureJoinRoute(args, env.PULLBOARD_MODEL);
    fixtureAddRoute(args);
    const result = runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr, failure: result.failure };
  };
  return { dir, env, git, tryGit, run, declareFamilies, declareFamily };
}

const CONFIG = {
  gate: 'test ! -f RED',
  spec: 'SPEC.md',
  verify: 'any',
  lease: '2h',
  landing: { perItem: false, manualOverride: true },
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
 * worktree joined to the web lane. Vendors stay undeclared by default; setting-on cases use
 * sandbox({ declareFamilies: true }) for explicit synthetic labels. The coordinator's model
 * stays deliberately undeclared; later agents retain the runner's model.
 * Coordinator-only fixtures may omit the unused worktree and its join.
 */
function project(gate = CONFIG.gate, box = sandbox(), { separateGitDir = false, withWorktree = true } = {}) {
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main', ...(separateGitDir ? ['--separate-git-dir', join(box.dir, 'separate-git')] : []));
  const inheritedModel = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  assert.equal(box.run(repo, 'init').code, 0);
  if (box.declareFamilies) withFixtureBoard({ ...box, repo }, board => {
    store.register(board, { lane: 'coordinator', path: repo, family: box.declareFamily(repo, 'Fixture Coordinator Vendor') });
  });
  box.git(repo, 'config', 'user.name', 'Test Agent');
  box.git(repo, 'config', 'user.email', 'agent@example.com');
  if (inheritedModel !== undefined) box.env.PULLBOARD_MODEL = inheritedModel;
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  if (!withWorktree) return { ...box, repo };
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const joined = joinFixtureSeat(box, web, 'web', { model: 'fixture-model' });
  assert.equal(joined.code, 0, `fixture join failed (code ${joined.code}): ${joined.err}\n${joined.out}`);
  const seat = JSON.parse(joined.out);
  assert.equal(seat.agent, 'web-1');
  assert.equal(seat.lane, 'web');
  assert.equal(seat.route, 'strong');
  assert.equal(seat.model, 'fixture-model');
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
  return { command: `${quote(process.execPath)} ${quote(script)} ${quote(mode)} ${quote(release)} ${quote(events)}`, mode, release, events };
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

async function startView(box, cwd, { nodeArgs = [] } = {}) {
  const startedAt = performance.now();
  const args = [...nodeArgs, BIN, 'view', '--no-open', '--port', '0'];
  const child = spawn(process.execPath, args, { cwd, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' } });
  const link = await new Promise((found, fail) => {
    let out = '';
    let stderr = '';
    let settled = false;
    const rejectStartup = (code, signal, extra = '') => {
      if (settled) return;
      settled = true;
      const failure = reportFixtureChildFailure({ command: process.execPath, args,
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

/** Reopen the CLI's actual SQLite file to seed private integration data that later CLI processes read. */
function withFixtureBoard(box, work) {
  // File-backed boundary: subsequent real CLI processes must read these exact persisted fixture rows.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  try { return work(board); }
  finally { store.closeBoard(board); }
}

/** Seed a legacy receipt from the old full-gate-only submit rule, for independent verifier audits. */
function historicalCheckSubmission(box, commit) {
  box.git(box.web, 'update-ref', `refs/pullboard/items/1/${commit.slice(0, 12)}`, commit);
  withFixtureBoard(box, board => submitFixture(board, 1, { agentId: 'web-1', commit, tree: box.git(box.web, 'rev-parse', `${commit}^{tree}`) }));
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
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Private check', criterion: 'the installed check passes', check, args: ['--specs', 'G1'] });
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/.gitignore'), '.deps/\n');
  writeFileSync(join(box.web, 'web/index.html'), 'fixture');
  const commit = attackCommit(box, box.web);
  historicalCheckSubmission(box, commit);
  const review = join(box.dir, 'private-check-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(joinFixtureSeat(box, review, 'api').code, 0);
  const reserved = box.run(review, 'next', '--verify', '1', '--json');
  assert.equal(reserved.code, 0, reserved.out || reserved.err);
  return { ...box, review, commit };
}


  return {
    BIN, cockpitSource, sandboxes, cleanup, sandbox, CONFIG, SPEC, project,
    holdingGate, launch, waitFor, gateEvents, commitFile, attackCommit, historicalCheckSubmission, privateCheckSubmission,
    startView, LIGHT_BRIEF,
  };
}

/** Run the public CLI in one private session without letting a peer inherit its identity. */
export function crossLaneFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixture = helpers.sandbox();
  fixture.env.PULLBOARD_MODEL = 'Cross-lane test';
  const box = helpers.project('true', fixture);
  const session = 'cross-lane-owner-session';
  /** Each command gets its actual invoking session, and the surrounding fixture keeps none. */
  function runAs(identity, cwd, ...args) {
    const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
    box.env.CLAUDECODE = '1';
    box.env.CLAUDE_CODE_SESSION_ID = identity;
    try { return box.run(cwd, ...args); }
    finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete box.env[name];
        else box.env[name] = value;
      }
    }
  }
  /** Demand real command success before interpreting its versioned result. */
  function json(result) {
    assert.equal(result.code, 0, `${result.out}\n${result.err}`);
    return JSON.parse(result.out);
  }
  /** An existing seat is joined by the actual owner session, rather than a test-only owner flag. */
  function seat(name, lane, identity, route = 'strong', lockLane = false) {
    const root = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, 'main');
    return { ...json(joinFixtureSeat(box, root, lane, { route, lockLane, model: 'Cross-lane test', run: (cwd, ...args) => runAs(identity, cwd, ...args) })), root };
  }
  /** Add an ordinary routed item through the coordinator CLI with its lane's approved row; each title names its own file so items never collide on one path. */
  function add(lane, title, route = 'strong') {
    return fileFixtureItem(box, box.repo, { lane, title, route,
      criterion: 'The item can be built and checked from its brief.', check: 'true', diagnose: false,
      brief: `Files: ${lane}/${route}-${title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')}.js\nChange: build the fixture item\nTest: the check proves the fixture`,
      args: ['--specs', lane === 'api' ? 'G2' : 'G1'] }).item_id;
  }
  /** Keep the test's queue order explicit without touching a production board. */
  function milestone(name, id) {
    json(box.run(box.repo, 'milestone', 'add', name, '--items', String(id), '--reason', 'Arrange fixture release', '--json'));
  }
  /** Read the local checkout binding only; a session digest must never become board metadata. */
  function binding(root) {
    return JSON.parse(readFileSync(join(resolve(root, box.git(root, 'rev-parse', '--git-dir')), 'pullboard-checkout-session.json'), 'utf8'));
  }
  return { ...box, session, runAs, json, seat, add, milestone, binding };
}
