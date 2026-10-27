/** Real HTTP calls against an isolated Git repo and the actual board engine (A2). */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { runFixtureChild, runFixtureGit, startFixtureChild } from './fixture-child.js';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createLocalApiHandler, serveApi } from '../src/api.js';
import { serveView } from '../src/serve.js';
import { main } from '../src/cli.js';
import { applyStateDelta, createApiHandler } from '../src/api-http.js';
import { WHOLE_STATE_DELTA_FIELDS } from '../src/api-delta-fields.js';
import { registryFile, registerProject, forgetProject } from '../src/projects.js';
import { Refused } from '../src/refused.js';
import * as store from '../src/board.js';
import { preparePersonRequest } from '../src/person-request.js';
import { receivePersonRequest } from '../src/relay-requests.js';
import { fetchFresh } from './http-fixture.js';
import { liveFrames } from './http-stream-fixture.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Run a private view in a child process with child-process accounting enabled only for warmed reads. */
const REPEATED_READ_HARNESS = `
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const gitIdentity = { ...process.env, GIT_AUTHOR_NAME: 'HTTP Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
  GIT_COMMITTER_NAME: 'HTTP Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid' };
const counters = { git: 0, node: 0, other: 0, methods: {}, gitCalls: [], otherCalls: [] };
let counting = false;
let currentRoute = 'setup';
const childMethods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
/** Count one child-process API call by its executable class while measurement is enabled. */
function countChild(method, args) {
  const raw = method === 'fork' ? process.execPath : String(args[0] ?? '');
  const command = raw.trim().split(/\\s+/u)[0].replace(/^['"]|['"]$/gu, '');
  const base = basename(command).replace(/\\.exe$/iu, '').toLowerCase();
  const kind = base === 'git' ? 'git' : (command === process.execPath || base === 'node' ? 'node' : 'other');
  counters[kind] += 1;
  counters.methods[method] = (counters.methods[method] ?? 0) + 1;
  if (kind === 'other' && counters.otherCalls.length < 32) {
    counters.otherCalls.push({ method, argv: [raw, ...(Array.isArray(args[1]) ? args[1] : [])],
      stack: String(new Error().stack ?? '').slice(0, 3000) });
  }
  if (kind === 'git' && counters.gitCalls.length < 32) {
    const commandArgs = Array.isArray(args[1]) ? args[1].slice(0, 32).map(value => String(value).slice(0, 512)) : [];
    const options = Array.isArray(args[1]) ? args[2] : args[1];
    counters.gitCalls.push({ route: currentRoute, method, argv: [raw, ...commandArgs], cwd: options?.cwd ?? process.cwd(),
      stack: String(new Error().stack ?? '').split('\\n').slice(2, 10).map(line => line.slice(0, 512)) });
  }
}
for (const method of childMethods) {
  const original = childProcess[method];
  /** Count this built-in call when measured, then preserve its original behavior. */
  childProcess[method] = function (...args) {
    if (counting) countChild(method, args);
    return Reflect.apply(original, this, args);
  };
}
syncBuiltinESMExports();

const [serveFile, projectJson, codeMetadataMarker] = process.argv.slice(1);
const projects = JSON.parse(projectJson);
const { serveView } = await import(pathToFileURL(serveFile).href);
const view = await serveView({ port: 0 });
const address = new URL(view.url);
const key = address.searchParams.get('k');
let pageReady = false;
let pageUrl = view.url;
let pageCookie = '';
let requestCount = 0;
/** Fetch one authenticated API response and reject failed fixture requests. */
async function readApi(path) {
  currentRoute = 'GET ' + path;
  requestCount += 1;
  const response = await fetch(address.origin + path, { headers: { ...(pageCookie ? { cookie: pageCookie } : { 'x-pullboard-key': key }), connection: 'close' } });
  const document = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ route: currentRoute, document }));
  return document;
}
/** Fetch the actual local view page and require a successful response. */
async function readPage() {
  currentRoute = 'GET /';
  if (!pageReady) {
    requestCount += 1;
    const exchange = await fetch(view.url, { headers: { connection: 'close' }, redirect: 'manual' });
    if (exchange.status === 200) {
      assert.match(await exchange.text(), /<!doctype html>/iu);
      pageReady = true;
      return;
    }
    assert.equal(exchange.status, 303, 'the printed view link either serves the page or trades its key for a session cookie');
    const location = exchange.headers.get('location');
    assert.ok(location, 'the key exchange redirects to the clean page address');
    let cleanAddress;
    try { cleanAddress = new URL(location, address.origin); }
    catch { assert.fail('the key exchange returns a valid clean page address'); }
    assert.equal(cleanAddress.origin, address.origin, 'the key exchange stays on this view');
    assert.equal(cleanAddress.searchParams.has('k'), false, 'the redirected page address drops the key');
    const setCookie = exchange.headers.get('set-cookie');
    assert.ok(setCookie, 'the key exchange sets a session cookie');
    const cookieParts = setCookie.split(';');
    const cookiePair = cookieParts.shift();
    const cookieAttributes = new Set(cookieParts.map((part) => part.trim().toLowerCase()));
    assert.equal(/^pullboard_view_[0-9a-f]{18}=[A-Za-z0-9_-]+$/u.test(cookiePair), true, 'the response sets a per-view session cookie');
    assert.equal(cookieAttributes.has('path=/'), true, 'the session cookie covers the view routes');
    assert.equal(cookieAttributes.has('httponly'), true, 'the session cookie is not readable by page scripts');
    assert.equal(cookieAttributes.has('samesite=strict'), true, 'the session cookie is same-site only');
    pageUrl = cleanAddress;
    pageCookie = cookiePair;
    pageReady = true;
  }
  requestCount += 1;
  const response = await fetch(pageUrl, { headers: { connection: 'close', ...(pageCookie ? { cookie: pageCookie } : { 'x-pullboard-key': key }) } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<!doctype html>/iu);
}
/** Read each selected board state and one known item detail. */
async function readAllRoutes(boards) {
  await readPage();
  await readApi('/api/v1/boards');
  for (const project of projects) {
    const board = boards.find((entry) => resolve(entry.root) === resolve(project.root));
    assert.ok(board, 'the private registry lists every fixture project');
    const path = '/api/v1/boards/' + board.id;
    await readApi(path + '/state');
    await readApi(path + '/items/' + project.item);
  }
}

try {
  await readPage();
  const initial = await readApi('/api/v1/boards');
  assert.equal(initial.boards.length, 3);
  const boards = initial.boards;
  await readAllRoutes(boards);
  const measuredRequests = requestCount;
  counters.git = 0;
  counters.node = 0;
  counters.other = 0;
  counters.methods = {};
  counters.gitCalls = [];
  counters.otherCalls = [];
  requestCount = 0;
  if (codeMetadataMarker) {
    const changed = new Date(0);
    utimesSync(codeMetadataMarker, changed, changed);
  }
  const started = performance.now();
  counting = true;
  try {
    if (codeMetadataMarker) {
      const first = projects[0];
      const board = boards.find(entry => resolve(entry.root) === resolve(first.root));
      await readApi('/api/v1/boards/' + board.id + '/items/' + first.item);
    }
    await readAllRoutes(boards);
    await readAllRoutes(boards);
  } finally { counting = false; }
  const elapsedMs = performance.now() - started;
  const measurement = { boards: boards.length, routes: 'GET /api/v1/boards; 3x GET state; 3x GET item detail; GET /',
    warmupRequests: measuredRequests, requests: requestCount,
    rounds: 2, elapsedMs: Number(elapsedMs.toFixed(2)), processes: { ...counters, methods: { ...counters.methods } } };
  const provenanceChecks = [];
  if (codeMetadataMarker) {
    const { apiBoards } = await import(new URL('./api.js', pathToFileURL(serveFile)));
    const { withGitReadFacts } = await import(new URL('./git.js', pathToFileURL(serveFile)));
    // A deliberately stale board stamp forces a write-open below. Warm its one-time own-PID
    // diagnostic before measuring provenance; ordinary warmed reads still require zero children.
    const { prepareBoardWriteIdentity } = await import(new URL('./board-write-lock.js', pathToFileURL(serveFile)));
    prepareBoardWriteIdentity();
    for (const status of [undefined, true]) {
      // A current board opens read-only with no authority to decide; a cleared stamp makes each need a write open (#1047).
      for (const { root } of projects) {
        const db = new DatabaseSync(resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), 'pullboard', 'board.sqlite'));
        try { db.exec('PRAGMA application_id = 0'); } finally { db.close(); }
      }
      counters.git = 0;
      counters.node = 0;
      counters.other = 0;
      counters.methods = {};
      counters.gitCalls = [];
  counters.otherCalls = [];
      currentRoute = status === undefined ? 'unknown main status' : 'true main status';
      const changed = new Date(status === undefined ? 1000 : 2000);
      utimesSync(codeMetadataMarker, changed, changed);
      let listed;
      counting = true;
      try { listed = withGitReadFacts(() => apiBoards(() => projects, status)); }
      finally { counting = false; }
      assert.equal(listed.length, projects.length, 'authority controls read the actual private boards');
      provenanceChecks.push({ status: currentRoute, processes: { ...counters, methods: { ...counters.methods } } });
    }
  }
  process.stdout.write(JSON.stringify({ measurement, provenanceChecks }) + '\\n');

  const target = projects[0];
  const board = boards.find((entry) => resolve(entry.root) === resolve(target.root));
  const boardPath = '/api/v1/boards/' + board.id;
  const specPath = resolve(target.root, 'SPEC.md');
  const configPath = resolve(target.root, 'pullboard.json');
  const doctrinePath = resolve(target.root, 'DOCTRINE.md');
  /** Read the target state and return its payload. */
  async function state() { return (await readApi(boardPath + '/state')).state; }
  /** Change the target SPEC.md with a new approved goal row. */
  function writeSpec(id) {
    writeFileSync(specPath, '# HTTP fixture\\n\\n## Goals\\n- G1 [approved, must] Keep the board. | gate: true\\n- ' + id + ' [approved, must] Keep reads current. | gate: true\\n');
  }
  /** Advance the real fixture branch with Git plumbing; unrelated Pullboard commit hooks do not shape this cache probe. */
  function commitFixture(root, message) {
    const options = { cwd: root, env: gitIdentity, encoding: 'utf8' };
    const tree = execFileSync('git', ['write-tree'], options).trim();
    const parent = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-p', parent], { ...options, input: message }).trim();
    execFileSync('git', ['update-ref', 'HEAD', commit], options);
  }
  writeSpec('G2');
  execFileSync('git', ['add', 'SPEC.md'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  commitFixture(target.root, 'docs: refresh fixture spec [G1]');
  let current = await state();
  let head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target.root, env: process.env, encoding: 'utf8' }).trim();
  assert.ok(current.spec.some((row) => row.id === 'G2'));
  assert.equal(current.rowAgesAt['SPEC.md'], head, 'a new commit refreshes the file HEAD');

  execFileSync('git', ['switch', '-q', '-c', 'freshness-branch'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  writeSpec('G3');
  execFileSync('git', ['add', 'SPEC.md'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  commitFixture(target.root, 'docs: update branch fixture spec [G1]');
  current = await state();
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target.root, env: process.env, encoding: 'utf8' }).trim();
  assert.ok(current.spec.some((row) => row.id === 'G3'));
  assert.equal(current.rowAgesAt['SPEC.md'], head, 'a branch switch refreshes the selected HEAD');

  execFileSync('git', ['pack-refs', '--all', '--prune'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  assert.ok(readFileSync(resolve(target.root, '.git', 'packed-refs'), 'utf8').includes(' refs/heads/main\\n'),
    'the private fixture has a packed main ref');
  execFileSync('git', ['switch', '-q', 'main'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  current = await state();
  assert.ok(current.spec.some((row) => row.id === 'G2'), 'switching back refreshes the original branch state');
  execFileSync('git', ['pack-refs', '--all', '--prune'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  const packedRefs = readFileSync(resolve(target.root, '.git', 'packed-refs'), 'utf8');
  assert.ok(packedRefs.includes(' refs/heads/freshness-branch\\n'), 'the alternate ref is packed while main is checked out');
  execFileSync('git', ['switch', '-q', 'freshness-branch'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  current = await state();
  assert.ok(current.spec.some((row) => row.id === 'G3'), 'switching to a packed ref refreshes the selected state');
  execFileSync('git', ['switch', '-q', 'main'], { cwd: target.root, env: process.env, stdio: 'ignore' });

  writeSpec('G4');
  current = await state();
  assert.ok(current.spec.some((row) => row.id === 'G4'), 'an uncommitted SPEC.md edit appears on the next read');
  writeFileSync(doctrinePath, '# Local rules\\n\\n## Team Rules\\n\\n- LOCAL1 [approved, must] Keep the board readable. | gate: true\\n');
  current = await state();
  assert.ok(current.practice.some((row) => row.id === 'LOCAL1'), 'a DOCTRINE.md edit appears on the next read');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, lanes: { ...config.lanes, ops: { owns: [] } } }));
  current = await state();
  assert.ok(current.lanes.includes('ops'), 'a pullboard.json edit appears on the next read');

  const linked = projects[2];
  const linkedBoard = boards.find((entry) => resolve(entry.root) === resolve(linked.root));
  const linkedPath = '/api/v1/boards/' + linkedBoard.id + '/state';
  execFileSync('git', ['switch', '-q', '-c', 'linked-refresh'], { cwd: linked.root, env: process.env, stdio: 'ignore' });
  writeFileSync(resolve(linked.root, 'SPEC.md'), '# HTTP fixture\\n\\n## Goals\\n- G1 [approved, must] Keep the board. | gate: true\\n- G5 [approved, must] Keep the linked worktree current. | gate: true\\n');
  execFileSync('git', ['add', 'SPEC.md'], { cwd: linked.root, env: process.env, stdio: 'ignore' });
  commitFixture(linked.root, 'docs: refresh linked worktree [G1]');
  const linkedState = (await readApi(linkedPath)).state;
  const linkedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: linked.root, env: process.env, encoding: 'utf8' }).trim();
  assert.ok(linkedState.spec.some((row) => row.id === 'G5'));
  assert.equal(linkedState.rowAgesAt['SPEC.md'], linkedHead, 'a linked worktree branch change refreshes its state');
  process.stdout.write(JSON.stringify({ fresh: true }) + '\\n');
} finally {
  await view.close();
}
`;

/** Quote an executable path literally for the fixture's source-bin hook shim. */
function shellWord(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a private, committed project, with an exact-build hook shim and no personal Git config. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-http-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env, HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'home'),
    PATH: bin + ':' + process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'HTTP Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'HTTP Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
  };
  mkdirSync(env.HOME);
  /** Run Git only inside the private fixture. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  /** Exercise this worktree's real CLI with a private environment. */
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  /** Decode one successful versioned CLI invocation without printing session links. */
  function cli(cwd, ...args) {
    const result = run(cwd, ...args, '--json');
    let reason = result.stderr;
    if (result.status !== 0 && result.stdout) {
      try {
        const response = JSON.parse(result.stdout);
        const error = response?.error;
        if (error && typeof error === 'object') {
          reason = [result.stderr, error.code, error.message].filter(Boolean).join('\n');
        }
      } catch { /* Keep the existing stderr-only diagnostic for non-JSON failures. */ }
    }
    assert.equal(result.status, 0, reason);
    return JSON.parse(result.stdout);
  }
  git('init', '-q', '-b', 'main');
  cli(root, 'init');
  // HTTP fixtures file "true" checks to move items, so they keep a board with no hold setting.
  const { checks: _hold, ...config } = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8'));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] }, review: { owns: [] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: private HTTP fixture');
  return { root, dir, env, cli, run, commit: git('rev-parse', 'HEAD').trim() };
}

/** Serve this fixture's explicit project, avoiding any registry outside its private home. */
async function httpBox(t, { includeMissing = false, onStateBuild, additionalProjects = [] } = {}) {
  const box = fixture(t);
  const api = await serveApi({ runCommand: main, onStateBuild, projects: () => [...(includeMissing ? [{ root: join(box.dir, 'gone'), name: 'Missing fixture' }] : []), { root: box.root, name: 'HTTP fixture' }, ...additionalProjects] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  const origin = url.origin;
  /** Make a real HTTP call and decode its single versioned response. */
  async function call(path, value, headers = {}) {
    const response = await fetchFresh(origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const document = await response.json();
    assert.equal(document.version, 1);
    return { status: response.status, document };
  }
  const listed = await call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.equal(listed.document.boards.length, 1 + additionalProjects.length);
  const id = listed.document.boards.find((entry) => resolve(entry.root) === resolve(box.root)).id;
  assert.match(id, /^[0-9a-f]{32}$/);
  return { ...box, api, origin, key, id, call, path: '/api/v1/boards/' + id };
}

/** Serve one registered private fixture through the actual person's view adapter. */
async function viewHttpBox(t, existing = null) {
  const box = existing ?? fixture(t);
  const previousHome = process.env.PULLBOARD_HOME;
  let view;
  t.after(async () => {
    try { await view?.close(); }
    finally {
      if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
      else process.env.PULLBOARD_HOME = previousHome;
    }
  });
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  registerProject(box.root);
  view = await serveView({ port: 0 });
  const url = new URL(view.url);
  const key = url.searchParams.get('k');
  const origin = url.origin;
  /** Make a real HTTP call to this fixture's person-owned view and decode its versioned response. */
  async function call(path, value, headers = {}) {
    const response = await fetchFresh(origin + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { 'x-pullboard-key': key, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const document = await response.json();
    assert.equal(document.version, 1);
    return { status: response.status, document };
  }
  const listed = await call('/api/v1/boards');
  assert.equal(listed.status, 200);
  assert.equal(listed.document.boards.length, 1);
  const id = listed.document.boards[0].id;
  return { ...box, api: view, origin, key, id, call, path: '/api/v1/boards/' + id };
}

/** A private linked code checkout keeps provenance false while a metadata touch invalidates only its private cache. */
test('a detail read after a cache miss on a linked board spawns no git process [A2,N26]', (t) => {
  const box = fixture(t);
  const roots = [box.root];
  for (const number of [2, 3]) {
    const root = join(box.dir, 'repo-' + number);
    mkdirSync(root);
    runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env: box.env, stdio: 'pipe' });
    box.cli(root, 'init');
    const configPath = join(root, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] }, review: { owns: [] } } }));
    writeFileSync(join(root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
    writeFileSync(join(root, 'DOCTRINE.md'), '');
    runFixtureGit(['add', '-A'], { cwd: root, env: box.env, stdio: 'pipe' });
    runFixtureGit(['commit', '-q', '-m', 'chore: private HTTP fixture [G1]'], { cwd: root, env: box.env, stdio: 'pipe' });
    if (number === 3) {
      const linked = join(box.dir, 'repo-3-linked');
      runFixtureGit(['worktree', 'add', '-q', '-b', 'view-feature', linked], { cwd: root, env: box.env, stdio: 'pipe' });
      roots.push(linked);
    } else roots.push(root);
  }
  const projects = roots.map((root, index) => {
    const itemRoot = index === 2 ? join(box.dir, 'repo-3') : root;
    const added = box.cli(itemRoot, 'add', 'app', 'Read fixture item ' + (index + 1), '--criterion', 'appears in item detail', '--specs', 'G1');
    return { root, item: added.item.item_id };
  });
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  try {
    forgetProject(join(box.dir, 'repo-3'));
    for (const root of roots) registerProject(root);
  } finally {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
  }

  // The copied source has no connection to the shared classic .git. Its linked worktree provides
  // real, private `isMain === false` provenance for the code that serves these API requests.
  const codePrimary = join(box.dir, 'code-primary');
  const codeLinked = join(box.dir, 'code-linked');
  mkdirSync(codePrimary);
  cpSync(resolve(import.meta.dirname, '../src'), join(codePrimary, 'src'), { recursive: true });
  cpSync(resolve(import.meta.dirname, '../package.json'), join(codePrimary, 'package.json'));
  cpSync(resolve(import.meta.dirname, '../CHANGELOG.md'), join(codePrimary, 'CHANGELOG.md'));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: codePrimary, env: box.env, stdio: 'pipe' });
  runFixtureGit(['add', 'src', 'package.json', 'CHANGELOG.md'], { cwd: codePrimary, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'chore: private copied product source'], { cwd: codePrimary, env: box.env, stdio: 'pipe' });
  runFixtureGit(['worktree', 'add', '-q', '--detach', codeLinked], { cwd: codePrimary, env: box.env, stdio: 'pipe' });
  const privateCommonDir = realpathSync.native(join(codePrimary, '.git'));
  let assertionFailed = false;
  try {
    const result = runFixtureChild(process.execPath, [
      '--input-type=module', '-e', REPEATED_READ_HARNESS,
      join(codeLinked, 'src', 'serve.js'), JSON.stringify(projects), privateCommonDir,
    ], { cwd: box.root, env: box.env, encoding: 'utf8' });
    const initialContext = JSON.stringify({
      route: 'GET /api/v1/boards; 3x state; 3x item detail; GET /',
      argv: [process.execPath, '--input-type=module', '-e', 'REPEATED_READ_HARNESS', join(codeLinked, 'src', 'serve.js'), 'projects-json', privateCommonDir],
      cwd: box.root, status: result.status, stderr: String(result.stderr ?? '').slice(-2_000), failure: String(result.failure ?? '').slice(-2_000),
    });
    assert.ok(result.stdout.trim(), initialContext);
    const lines = result.stdout.trim().split('\n');
    const measurement = JSON.parse(lines[0]).measurement;
    const context = JSON.stringify({ route: measurement.routes, cwd: box.root, status: result.status,
      gitCalls: measurement.processes.gitCalls, stderr: String(result.stderr ?? '').slice(-2_000), failure: String(result.failure ?? '').slice(-2_000) });
    process.stderr.write(`private linked-code repeated view reads: processes=${JSON.stringify(measurement.processes)}, attribution=${context}\n`);
    assert.deepEqual({ git: measurement.processes.git, node: measurement.processes.node, other: measurement.processes.other },
      { git: 0, node: 0, other: 0 }, context);
    const controls = JSON.parse(lines[0]).provenanceChecks;
    assert.deepEqual(controls.map(control => control.status), ['unknown main status', 'true main status']);
    for (const control of controls) {
      assert.equal(control.processes.git, 1, JSON.stringify(control));
      assert.ok(control.processes.gitCalls.some(call => call.stack.some(line => line.includes('readCodeIsFromMain'))),
        'unknown and true main status still check actual code provenance');
      assert.equal(control.processes.node + control.processes.other, 0, JSON.stringify(control));
    }
    assert.equal(result.status, 0, context);
    assert.equal(JSON.parse(lines.at(-1)).fresh, true, context);
  } catch (error) {
    assertionFailed = true;
    throw error;
  } finally {
    try { runFixtureGit(['worktree', 'remove', codeLinked], { cwd: codePrimary, env: box.env, stdio: 'pipe' }); }
    catch (cleanupError) { if (!assertionFailed) throw cleanupError; }
  }
});

/** Prove warmed reads across three registered projects start no child processes and changes refresh state. */
test('a repeated read through the view page spawns no process [A2,N26]', (t) => {
  const box = fixture(t);
  const roots = [box.root];
  for (const number of [2, 3]) {
    const root = join(box.dir, 'repo-' + number);
    mkdirSync(root);
    runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env: box.env, stdio: 'pipe' });
    box.cli(root, 'init');
    const configPath = join(root, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, gate: 'true', lanes: { app: { owns: ['app/'] }, review: { owns: [] } } }));
    writeFileSync(join(root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n');
    writeFileSync(join(root, 'DOCTRINE.md'), '');
    runFixtureGit(['add', '-A'], { cwd: root, env: box.env, stdio: 'pipe' });
    runFixtureGit(['commit', '-q', '-m', 'chore: private HTTP fixture [G1]'], { cwd: root, env: box.env, stdio: 'pipe' });
    if (number === 3) {
      const linked = join(box.dir, 'repo-3-linked');
      runFixtureGit(['worktree', 'add', '-q', '-b', 'view-feature', linked], { cwd: root, env: box.env, stdio: 'pipe' });
      roots.push(linked);
    } else roots.push(root);
  }

  const projects = roots.map((root, index) => {
    // Write the shared board from its primary checkout; the linked checkout remains a read-only fixture.
    const itemRoot = index === 2 ? join(box.dir, 'repo-3') : root;
    const added = box.cli(itemRoot, 'add', 'app', 'Read fixture item ' + (index + 1), '--criterion', 'appears in item detail', '--specs', 'G1');
    return { root, item: added.item.item_id };
  });
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  try {
    // CLI setup registers the primary; measure its linked checkout instead as the third board.
    forgetProject(join(box.dir, 'repo-3'));
    for (const root of roots) registerProject(root);
  } finally {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
  }
  // Keep the fixture's ordinary private Git config and identity; run-tests removes inherited repo/object selectors.
  const result = runFixtureChild(process.execPath, [
    '--input-type=module', '-e', REPEATED_READ_HARNESS,
    resolve(import.meta.dirname, '../src/serve.js'), JSON.stringify(projects),
  ], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.ok(result.stdout.trim(), result.failure ?? result.stderr);
  const lines = result.stdout.trim().split('\n');
  const measurement = JSON.parse(lines[0]).measurement;
  process.stderr.write(`a repeated read through the view page spawns no process: boards=${measurement.boards}, routes=${measurement.routes}, requests=${measurement.requests}, rounds=${measurement.rounds}, processes=${JSON.stringify(measurement.processes)}, elapsed=${measurement.elapsedMs}ms\n`);
  assert.deepEqual({ git: measurement.processes.git, node: measurement.processes.node, other: measurement.processes.other },
    { git: 0, node: 0, other: 0 }, 'repeated board-list, state, item-detail, and page reads start no child process after warm-up');
  assert.equal(result.status, 0, result.failure ?? result.stderr);
  const report = JSON.parse(lines.at(-1));
  assert.equal(report.fresh, true, 'commit, packed refs, linked worktree, SPEC.md, DOCTRINE.md, and pullboard.json changes appear on the next read');
});

test('[A2] a stale registered folder does not hide another readable board', async (t) => {
  const box = await httpBox(t, { includeMissing: true });
  const listed = await box.call('/api/v1/boards');
  assert.equal(listed.document.boards.length, 1);
  assert.equal(listed.document.warnings.length, 1);
  assert.equal(listed.document.warnings[0].name, 'Missing fixture');
  assert.equal(listed.document.warnings[0].error.version, 1);
  assert.equal(listed.document.warnings[0].error.error.code, 'BOARD_UNAVAILABLE');
  assert.match(listed.document.warnings[0].error.error.next, /pullboard forget/);
  const state = await box.call(box.path + '/state');
  assert.equal(state.status, 200);
  assert.equal(state.document.state.board, box.id);
});

/** Prove the authenticated HTTP state reuses a complete snapshot until one of its inputs changes. */
async function cachedHttpStateTest(t) {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const agent = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const hostileShout = 'cache baseline "quoted" \\ path\nline\n", "proofStats": {"flow":"forged"}';
  box.cli(box.root, 'shout', 'app', hostileShout);

  const first = await box.call(box.path + '/state');
  assert.equal(first.status, 200);
  assert.equal(builds, 1);
  assert.ok(first.document.state.shouts.some((shout) => shout.shout_text === hostileShout));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const unchanged = await box.call(box.path + '/state');
  assert.equal(builds, 1, 'an identical refresh reuses the complete board state');
  assert.ok(unchanged.document.state.shouts.some((shout) => shout.shout_text === hostileShout));
  assert.notEqual(unchanged.document.state.proofStats.flow.asOf, first.document.state.proofStats.flow.asOf);

  const latestShout = first.document.state.shouts.at(-1).shout_id;
  const unread = await box.call(box.path + '/state?seen=0');
  assert.equal(unread.document.state.unseen.since, 0);
  assert.ok(unread.document.state.unseen.count > 0);
  const read = await box.call(box.path + '/state?seen=' + latestShout);
  assert.deepEqual(read.document.state.unseen, { since: latestShout, count: 0 });
  assert.equal(builds, 1, 'the request-specific seen cursor does not rebuild or mutate the shared state');

  box.cli(box.root, 'add', 'app', 'cache invalidation item', '--criterion', 'visible after the next refresh', '--specs', 'G1');
  const moved = await box.call(box.path + '/state');
  assert.equal(builds, 2);
  assert.ok(moved.document.state.items.some((item) => item.title === 'cache invalidation item'));

  writeFileSync(join(box.root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n- G2 [approved, must] Keep the cache fresh. | gate: true\n');
  const spec = await box.call(box.path + '/state');
  assert.equal(builds, 3);
  assert.ok(spec.document.state.spec.some((row) => row.id === 'G2'));

  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, lease: '1m', lanes: { ...config.lanes, ops: { owns: [] } } }));
  const configured = await box.call(box.path + '/state');
  assert.equal(builds, 4);
  assert.ok(configured.document.state.lanes.includes('ops'));

  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] Keep the local board readable. | gate: true\n');
  const doctrine = await box.call(box.path + '/state');
  assert.equal(builds, 5);
  assert.ok(doctrine.document.state.practice.some((row) => row.id === 'LOCAL1'));

  writeFileSync(join(box.root, 'cache-head.txt'), 'advance HEAD without a board event\n');
  runFixtureGit(['add', 'cache-head.txt'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  runFixtureGit(['commit', '-q', '-m', 'chore: advance fixture head'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const headed = await box.call(box.path + '/state');
  assert.equal(builds, 6);
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  assert.equal(headed.document.state.rowAgesAt['SPEC.md'], head);

  box.cli(box.root, 'shout', 'app', 'agent inbox cursor');
  const beforeInbox = await box.call(box.path + '/state');
  const agentBeforeInbox = beforeInbox.document.state.agents.find((entry) => entry.agent_id === agent.agent);
  const boardBeforeInbox = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.inbox(boardBeforeInbox, agent.agent);
  } finally {
    store.closeBoard(boardBeforeInbox);
  }
  const afterInbox = await box.call(box.path + '/state');
  const agentAfterInbox = afterInbox.document.state.agents.find((entry) => entry.agent_id === agent.agent);
  assert.equal(agentAfterInbox.agent_last_shout_id, Math.max(...beforeInbox.document.state.shouts.map((shout) => shout.shout_id)));
  assert.notEqual(agentAfterInbox.agent_last_shout_id, agentBeforeInbox.agent_last_shout_id);
  assert.equal(builds, 8, 'an inbox cursor change without an event invalidates the agent projection');

  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'Lease cache item', criterion: 'remain current', specs: 'G1' } });
  assert.equal(added.status, 200);
  const itemId = added.document.result.item.item_id;
  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: itemId, agent: agent.agent });
  assert.equal(claimed.status, 200);
  const active = await box.call(box.path + '/state');
  assert.equal(active.document.state.items.find((item) => item.id === itemId).status, 'claimed');
  const lastEvent = active.document.state.events[0].event_id;
  const leaseBoard = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let leaseUntil;
  try {
    leaseUntil = leaseBoard.db.prepare('SELECT item_lease_until FROM item WHERE item_id = ?').get(itemId).item_lease_until;
  } finally {
    store.closeBoard(leaseBoard);
  }
  assert.ok(Number.isFinite(Date.parse(leaseUntil)));
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.tick(Math.max(1, Date.parse(leaseUntil) - now + 1));
  const expired = await box.call(box.path + '/state');
  assert.equal(expired.document.state.items.find((item) => item.id === itemId).status, 'open');
  assert.equal(expired.document.state.items.find((item) => item.id === itemId).claim, null);
  assert.equal((await box.call(box.path + '/items/' + itemId)).document.item.owner, null);
  assert.equal(expired.document.state.events[0].event_id, lastEvent, 'lease expiry changed no board event');
  assert.equal(builds, 10, 'clock-only lease expiry invalidates the cached state');
}

test('[A2, N26] an unchanged board state is reused and a move rebuilds it', cachedHttpStateTest);

test("[A2, N26] the board state sends summaries and an item's detail comes from its own path", async (t) => {
  const box = await httpBox(t);
  const builder = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-builder');
  const verifier = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-verifier');
  /** Make one real board move through HTTP and return its result. */
  async function move(body) {
    const moved = await box.call(box.path + '/moves', body);
    assert.equal(moved.status, 200, JSON.stringify(moved.document));
    return moved.document.result;
  }
  const accepted = (await move({ verb: 'add', args: {
    lane: 'app', title: 'Accepted summary item', criterion: 'Every list reads the Zebra marker', brief: 'A brief only the detail carries',
    specs: 'G1', check: 'true', wait: true,
  } })).item.item_id;
  await move({ verb: 'claim', item: accepted, agent: builder.agent });
  await move({ verb: 'fact', item: accepted, agent: builder.agent, args: { kind: 'note', text: 'a fact only the thread carries' } });
  await move({ verb: 'submit', item: accepted, agent: builder.agent });
  await move({ verb: 'next', agent: verifier.agent, args: { verify: true } });
  await move({ verb: 'verify', item: accepted, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'ran the check and read the summary' } });
  const claimed = (await move({ verb: 'add', args: { lane: 'app', title: 'Claimed summary item', criterion: 'stays claimed', specs: 'G1' } })).item.item_id;
  await move({ verb: 'claim', item: claimed, agent: builder.agent });
  const open = (await move({ verb: 'add', args: { lane: 'app', title: 'Open summary item', criterion: 'waits for a builder', specs: 'G1' } })).item.item_id;
  box.cli(box.root, 'milestone', 'add', 'Delivery', '--items', String(accepted));
  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let leaseUntil;
  try { leaseUntil = board.db.prepare('SELECT item_lease_until FROM item WHERE item_id = ?').get(claimed).item_lease_until; } finally { store.closeBoard(board); }

  const summaryFields = ['id', 'title', 'lane', 'status', 'route', 'milestone', 'specs', 'claim', 'builtBy', 'blockedBy', 'updatedAt', 'stage', 'since', 'counts', 'verdict'];
  const summaryState = await box.call(box.path + '/state');
  assert.equal(summaryState.status, 200);
  const fullState = await box.call(box.path + '/state?detail=full');
  assert.equal(fullState.status, 200);
  const summaries = new Map(summaryState.document.state.items.map((item) => [item.id, item]));
  const fulls = new Map(fullState.document.state.items.map((item) => [item.id, item]));
  assert.deepEqual([...summaries.keys()], [open, claimed, accepted], 'the state still lists every item, in board order');
  assert.deepEqual([...fulls.keys()], [...summaries.keys()]);
  for (const summary of summaries.values()) {
    assert.deepEqual(Object.keys(summary), summaryFields, `#${summary.id} carries only the summary fields`);
  }
  for (const full of fulls.values()) {
    for (const field of ['thread', 'verdicts', 'history', 'brief', 'criterion', 'check', ...summaryFields]) assert.ok(Object.hasOwn(full, field), `detail=full keeps #${full.id}'s ${field}`);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(summaryState.document)) < Buffer.byteLength(JSON.stringify(fullState.document)));
  assert.equal(JSON.stringify(summaryState.document).includes('A brief only the detail carries'), false, 'no brief text in the summaries');
  assert.equal(JSON.stringify(summaryState.document).includes('Zebra'), false, 'no criterion text in the summaries');

  const acceptedFull = fulls.get(accepted);
  assert.deepEqual(summaries.get(accepted), {
    id: accepted, title: 'Accepted summary item', lane: 'app', status: 'verified', route: acceptedFull.route, milestone: 'Delivery',
    specs: ['G1'], claim: null, builtBy: builder.agent, blockedBy: [], updatedAt: acceptedFull.updatedAt, stage: 'accepted',
    since: acceptedFull.history.findLast((event) => event.kind === 'accept').at, counts: { verdicts: 1, facts: 1 },
    verdict: { decision: 'ACCEPT', reason: 'CRITERION_MET' },
  });
  const claimedFull = fulls.get(claimed);
  assert.deepEqual(summaries.get(claimed).claim, { by: builder.agent, until: leaseUntil });
  assert.equal(summaries.get(claimed).stage, 'claimed');
  assert.equal(summaries.get(claimed).since, claimedFull.history.findLast((event) => event.kind === 'claim').at);
  assert.deepEqual(summaries.get(open), {
    id: open, title: 'Open summary item', lane: 'app', status: 'open', route: fulls.get(open).route, milestone: null,
    specs: ['G1'], claim: null, builtBy: null, blockedBy: [], updatedAt: fulls.get(open).updatedAt, stage: 'open',
    since: fulls.get(open).history.find((event) => event.kind === 'add').at, counts: { verdicts: 0, facts: 0 }, verdict: null,
  });
  assert.deepEqual(summaryState.document.state.moveCounts, {
    'open>claimed:claim': 2, 'claimed>submitted:submit': 1, 'submitted>submitted:reserve': 1, 'submitted>verified:accept': 1,
  }, 'the lifecycle drawing tallies the moves without any history');
  assert.deepEqual(fullState.document.state.moveCounts, summaryState.document.state.moveCounts);

  for (const [id, full] of fulls) {
    const detail = await box.call(box.path + '/items/' + id);
    assert.equal(detail.status, 200);
    assert.deepEqual({ ...summaries.get(id), ...detail.document.item }, full, `#${id}'s summary and detail make its full item`);
    const carried = Object.keys(detail.document.item).filter((field) => summaryFields.includes(field));
    assert.deepEqual(carried, ['id', 'verdict'], 'the detail repeats only the id and the whole latest verdict');
    for (const field of ['thread', 'verdicts', 'history', 'brief', 'criterion', 'check', 'owner', 'reviewer', 'reviewUntil', 'verifiedBy', 'commit', 'merged']) {
      assert.ok(Object.hasOwn(detail.document.item, field), `#${id}'s detail carries ${field}`);
    }
  }
  const acceptedDetail = (await box.call(box.path + '/items/' + accepted)).document.item;
  assert.equal(acceptedDetail.brief, 'A brief only the detail carries');
  assert.equal(acceptedDetail.criterion, 'Every list reads the Zebra marker');
  assert.equal(acceptedDetail.check, 'true');
  assert.equal(acceptedDetail.checkBaseline.result, 'green');
  assert.equal(acceptedDetail.verdict.note, 'ran the check and read the summary\nverified against agent-approved G1',
    'the post-init approved fixture row qualifies the receipt without losing the reviewer note');
  assert.deepEqual(acceptedDetail.thread.filter((entry) => entry.type === 'fact').map((entry) => entry.text), ['a fact only the thread carries']);

  /** Search through HTTP and return the matching ids in board order. */
  const search = async (text) => {
    const found = await box.call(box.path + '/items?q=' + encodeURIComponent(text));
    assert.equal(found.status, 200);
    return found.document.ids;
  };
  assert.deepEqual(await search('zebra'), [accepted], 'the criterion is searched without being in the state');
  assert.deepEqual(await search('  CLAIMED summary '), [claimed], 'trimmed text matches a title, ignoring case');
  assert.deepEqual(await search('#' + open), [open], 'an #id matches its item');
  assert.deepEqual(await search('g1'), [open, claimed, accepted], 'spec ids match');
  assert.deepEqual(await search('APP'), [open, claimed, accepted], 'the lane matches');
  assert.deepEqual(await search(''), [open, claimed, accepted], 'no text matches every item, as the view shows them all');
  assert.deepEqual(await search('no item says this'), []);

  const missing = await box.call(box.path + '/items/9999');
  assert.equal(missing.status, 404);
  assert.equal(missing.document.error.code, 'NO_ITEM');
  for (const rawId of ['0', 'abc', '1.5']) {
    const malformed = await box.call(box.path + '/items/' + rawId);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.document.error.code, 'BAD_REQUEST');
  }
  const posted = await box.call(box.path + '/items/' + accepted, {});
  assert.equal(posted.status, 400);
  const badDetail = await box.call(box.path + '/state?detail=everything');
  assert.equal(badDetail.status, 400);
  assert.equal(badDetail.document.error.code, 'BAD_REQUEST');
  assert.deepEqual((await box.call(box.path + '/state?detail=summary')).document.state.items, summaryState.document.state.items);

  // pullboard serve itself sends summaries; a page's own server, built as the view builds it, keeps full items until it opts in.
  const served = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json'], { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((done) => served.once('close', done));
  t.after(async () => { served.kill('SIGTERM'); await exited; });
  const servedUrl = await new Promise((found, fail) => {
    let out = '';
    served.stdout.setEncoding('utf8');
    served.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /"url":\s*"([^"]+)"/.exec(out);
      if (match) found(new URL(match[1]));
    });
    served.once('close', (code) => fail(new Error('pullboard serve exited ' + code + ' before printing its address: ' + out)));
  });
  const servedState = await fetchFresh(servedUrl.origin + box.path + '/state', { headers: { 'x-pullboard-key': servedUrl.searchParams.get('k') } });
  assert.equal(servedState.status, 200);
  assert.deepEqual((await servedState.json()).state.items, summaryState.document.state.items, 'pullboard serve sends the same summaries');
  let pagePort;
  const pageHandler = createLocalApiHandler({ secret: 'page-fixture-secret', getPort: () => pagePort, runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  const page = createServer(pageHandler);
  await new Promise((done) => page.listen(0, '127.0.0.1', done));
  pagePort = page.address().port;
  t.after(() => new Promise((done) => { pageHandler.close(); page.close(done); page.closeIdleConnections(); }));
  const pageState = await fetchFresh('http://127.0.0.1:' + pagePort + box.path + '/state', { headers: { 'x-pullboard-key': 'page-fixture-secret' } });
  assert.deepEqual((await pageState.json()).state.items, fullState.document.state.items, 'a page server that has not opted in keeps every item in full');
  const pageSummary = await fetchFresh('http://127.0.0.1:' + pagePort + box.path + '/state?detail=summary', { headers: { 'x-pullboard-key': 'page-fixture-secret' } });
  assert.deepEqual((await pageSummary.json()).state.items, summaryState.document.state.items, 'and sends summaries when asked');
});

test("[A2, N26] a sent-back item's summary carries its reject note's first line", async (t) => {
  const box = await httpBox(t);
  const builder = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-builder');
  const verifier = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-verifier');
  /** Make one real board move through HTTP and return its result. */
  async function move(body) {
    const moved = await box.call(box.path + '/moves', body);
    assert.equal(moved.status, 200, JSON.stringify(moved.document));
    return moved.document.result;
  }
  /** Build an item to submission and reserve its review for the verifier. */
  async function submitted(title) {
    const id = (await move({ verb: 'add', args: { lane: 'app', title, criterion: 'shows a greeting', specs: 'G1' } })).item.item_id;
    await move({ verb: 'claim', item: id, agent: builder.agent });
    await move({ verb: 'submit', item: id, agent: builder.agent });
    await move({ verb: 'next', agent: verifier.agent, args: { verify: true } });
    return id;
  }
  const note = 'The page shows no greeting.\nThe second line stays in the detail.';
  const rejected = await submitted('Rejected item');
  await move({ verb: 'verify', item: rejected, agent: verifier.agent, args: { decision: 'reject', reason: 'BEHAVIOR_MISMATCH', note } });
  const accepted = await submitted('Accepted item');
  await move({ verb: 'verify', item: accepted, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'The page greets by name.\nChecked twice.' } });

  const summaries = new Map((await box.call(box.path + '/state')).document.state.items.map((item) => [item.id, item]));
  assert.deepEqual(summaries.get(rejected).verdict, { decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', note: 'The page shows no greeting.' },
    'a sent-back row keeps its reason and the first line of the note');
  assert.deepEqual(summaries.get(accepted).verdict, { decision: 'ACCEPT', reason: 'CRITERION_MET' }, 'an accepted item carries no note');
  assert.equal((await box.call(box.path + '/items/' + rejected)).document.item.verdict.note, note, 'the whole note stays in the detail');

  await move({ verb: 'claim', item: rejected, agent: builder.agent });
  const reworked = (await box.call(box.path + '/state')).document.state.items.find((item) => item.id === rejected);
  assert.equal(reworked.verdict.note, 'The page shows no greeting.', 'a row being reworked still says why');
  const full = (await box.call(box.path + '/state?detail=full')).document.state.items.find((item) => item.id === rejected);
  assert.deepEqual({ ...reworked, ...(await box.call(box.path + '/items/' + rejected)).document.item }, full, 'the detail still completes the summary');
});

test('[A2, N26] a delta brings a snapshot up to date', async (t) => {
  const box = await httpBox(t);
  writeFileSync(join(box.root, 'SPEC.md'), '# HTTP fixture\n\n## Goals\n- G1 [approved, must] Keep the board. | gate: true\n- G2 [pending, must] Keep each delta small. | gate: true\n');
  runFixtureGit(['commit', '-qam', 'docs: ask whether deltas stay small'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const builder = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-builder');
  const verifier = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-verifier');
  /** Make one real board move through HTTP and return its result. */
  async function move(body) {
    const moved = await box.call(box.path + '/moves', body);
    assert.equal(moved.status, 200, JSON.stringify(moved.document));
    return moved.document.result;
  }
  const item = (await move({ verb: 'add', args: { lane: 'app', title: 'Delta item', criterion: 'moves through review', specs: 'G1' } })).item.item_id;
  const waiting = (await move({ verb: 'add', args: { lane: 'app', title: 'Waiting item', criterion: 'stays open', specs: 'G1', after: String(item) } })).item.item_id;

  const first = (await box.call(box.path + '/state')).document.state;
  assert.ok(Number.isSafeInteger(first.sequence), 'a snapshot names the event it reflects');
  let held = first;
  /**
   * Ask for what changed since the held snapshot, apply it, and compare it with a fresh snapshot
   * read at the same instant, so the flow observation in both is the same.
   */
  async function catchUp(label, observedAt = Date.now()) {
    t.mock.timers.enable({ apis: ['Date'], now: observedAt });
    try {
      const answer = await box.call(box.path + '/state?since=' + held.sequence);
      const fresh = await box.call(box.path + '/state');
      assert.equal(answer.status, 200, label);
      assert.ok(answer.document.delta, `${label}: ${JSON.stringify(answer.document.reset)}`);
      assert.equal(answer.document.since, held.sequence, label);
      assert.equal(answer.document.sequence, fresh.document.state.sequence, `${label}: the delta names the new latest sequence`);
      assert.equal(answer.document.eventLogVersion, fresh.document.eventLogVersion, label);
      const updated = applyStateDelta(held, answer.document.delta);
      assert.deepEqual(updated, fresh.document.state, `${label}: the delta brings the snapshot up to date`);
      assert.ok(JSON.stringify(answer.document).length < JSON.stringify(fresh.document).length, `${label}: the delta is smaller than a snapshot`);
      held = updated;
      return answer.document.delta;
    } finally {
      t.mock.timers.reset();
    }
  }
  const changed = (delta, field) => (delta.merge[field]?.set ?? []).map((entry) => entry[delta.merge[field].key]);

  await move({ verb: 'claim', item, agent: builder.agent });
  const claimed = await catchUp('claim');
  assert.deepEqual(changed(claimed, 'items'), [item], 'only the claimed item travels');
  assert.equal(claimed.merge.items.set[0].claim.by, builder.agent);
  assert.equal(Object.hasOwn(claimed.merge.items, 'ids'), false, 'no item came or went, so the order is not sent');
  const unchangedSequence = held.sequence;
  const nextObservation = Date.parse(held.observedAt) + 1; // One logical clock tick; no board move or timed wait.
  const still = await catchUp('only the observation clock changed', nextObservation);
  assert.equal(held.sequence, unchangedSequence, 'advancing the observation clock writes no board event');
  assert.equal(still.replace.observedAt, new Date(nextObservation).toISOString(),
    'even a no-event delta must refresh the held snapshot observation time');
  assert.deepEqual(still.merge, {}, 'an unchanged board merges nothing');
  assert.deepEqual(Object.keys(still.replace).sort(), [...WHOLE_STATE_DELTA_FIELDS].sort(),
    'only the declared per-read projections and small decision lists travel whole');
  assert.deepEqual(still.replace.decisionQueue, [], 'the unchanged empty coordinator queue travels as a whole field');

  await move({ verb: 'submit', item, agent: builder.agent });
  assert.equal((await catchUp('submit')).merge.items.set[0].status, 'submitted');

  await move({ verb: 'next', agent: verifier.agent, args: { verify: true } });
  await move({ verb: 'verify', item, agent: verifier.agent, args: { decision: 'accept', reason: 'CRITERION_MET', note: 'read every delta' } });
  const verdict = await catchUp('verdict');
  assert.deepEqual(changed(verdict, 'items').sort((a, b) => a - b), [item, waiting], 'the accept also unblocks the item waiting on it');

  const asked = await move({ verb: 'shout', agent: builder.agent, args: { to: 'coordinator', text: 'May the delta skip the order?', decision: true } });
  const shouted = await catchUp('shout');
  assert.ok(changed(shouted, 'shouts').includes(asked.id), 'the new shout travels');
  assert.ok(changed(shouted, 'asked').includes(asked.id), 'and so does the open question');
  assert.ok(shouted.replace.decisionQueue.some(row => row.shout_id === asked.id), 'the coordinator queue carries its actual new question');
  const answered = await move({ verb: 'answer', item: asked.id, args: { text: 'Only when nothing moved.' } });
  const answer = await catchUp('answer');
  assert.ok(changed(answer, 'shouts').includes(answered.id), 'the answer travels');
  assert.ok(answer.merge.asked.ids.every((id) => id !== asked.id), 'the answered question leaves the open list');
  assert.ok(answer.replace.decisionQueue.every(row => row.shout_id !== asked.id), 'the answered question also leaves the coordinator queue');

  box.cli(box.root, 'spec', 'approve', 'G2');
  const decided = await catchUp('spec decision');
  assert.deepEqual(changed(decided, 'spec'), ['G2'], 'only the decided spec row travels');

  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] Keep each delta exact. | gate: true\n');
  const unmoved = held.sequence;
  const edited = await catchUp('a doctrine edit without a move');
  assert.equal(held.sequence, unmoved, 'no event, so the sequence holds');
  assert.ok(changed(edited, 'practice').includes('LOCAL1'), 'the doctrine row travels anyway');
  await catchUp('again at the same sequence, which may repeat the edit but still applies exactly');

  held = first;
  await catchUp('every move at once, from the first snapshot');

  const ahead = await box.call(box.path + '/state?since=' + (held.sequence + 1000));
  assert.equal(ahead.status, 200);
  assert.equal(ahead.document.delta, null);
  assert.equal(ahead.document.reset.code, 'BASE_AHEAD');
  assert.match(ahead.document.reset.next, /\/state/);
  const format = await box.call(box.path + '/state?since=' + held.sequence + '&eventLogVersion=0');
  assert.equal(format.document.delta, null);
  assert.equal(format.document.reset.code, 'FORMAT_CHANGED', 'a snapshot in another event-log format is never extended');
  // A restarted server that has only read an item, or searched, never sent a snapshot: it cannot
  // extend the held one, even when a change with no event leaves the sequence where it was.
  writeFileSync(join(box.root, 'DOCTRINE.md'), '# Local rules\n\n## Team Rules\n\n- LOCAL1 [approved, must] A restarted server knows only what it sent. | gate: true\n');
  const restarted = await serveApi({ runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  t.after(() => restarted.close());
  const restartedUrl = new URL(restarted.url);
  /** Read through the restarted server with its own key. */
  const restartedRead = async (path) => (await fetchFresh(restartedUrl.origin + box.path + path, { headers: { 'x-pullboard-key': restartedUrl.searchParams.get('k') } })).json();
  assert.equal((await restartedRead('/items/' + item)).item.id, item);
  assert.deepEqual((await restartedRead('/items?q=delta')).ids, [item]);
  const unknownDocument = await restartedRead('/state?since=' + held.sequence);
  assert.equal(unknownDocument.delta, null, JSON.stringify(unknownDocument.delta));
  assert.equal(unknownDocument.reset.code, 'BASE_NOT_KEPT', 'a server that never sent that snapshot says so instead of guessing');
  const resent = (await restartedRead('/state')).state;
  assert.equal(resent.sequence, held.sequence, 'the doctrine edit wrote no event');
  assert.notDeepEqual(resent.practice, held.practice, 'so the held snapshot really is stale');
  assert.equal((await restartedRead('/state?since=' + held.sequence)).delta === null, false, 'once it sends a snapshot at that sequence, it can extend it');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const extended = applyStateDelta(resent, (await restartedRead('/state?since=' + resent.sequence)).delta);
    assert.deepEqual(extended, (await restartedRead('/state')).state, 'and its delta still brings that snapshot up to date');
  } finally {
    t.mock.timers.reset();
  }
  for (const [query, code] of [['since=', 'BAD_CURSOR'], ['since=-1', 'BAD_CURSOR'], ['since=1.5', 'BAD_CURSOR'], ['since=1&detail=full', 'BAD_REQUEST']]) {
    const refused = await box.call(box.path + '/state?' + query);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.document.error.code, code, query);
  }
});

test('[A2, N26] local milestone item status refreshes after an item event', async (t) => {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const agent = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const added = await box.call(box.path + '/moves', {
    verb: 'add', args: { lane: 'app', title: 'Roadmap item', criterion: 'refresh local status', specs: 'G1' },
  });
  assert.equal(added.status, 200);
  const itemId = added.document.result.item.item_id;
  box.cli(box.root, 'milestone', 'add', 'Delivery', '--items', String(itemId));

  const before = await box.call(box.path + '/state');
  assert.equal(builds, 1);
  assert.deepEqual(before.document.state.milestones[0].items[0], {
    id: itemId, title: 'Roadmap item', status: 'open', state: 'open',
  });

  const unchanged = await box.call(box.path + '/state');
  assert.equal(builds, 1, 'an unchanged local roadmap state reuses its cached snapshot');
  assert.deepEqual(unchanged.document.state.milestones, before.document.state.milestones);

  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: itemId, agent: agent.agent });
  assert.equal(claimed.status, 200);
  const after = await box.call(box.path + '/state');
  assert.equal(builds, 2, 'a real item event rebuilds the cached local roadmap');
  assert.deepEqual(after.document.state.milestones[0].items[0], {
    id: itemId, title: 'Roadmap item', status: 'claimed', state: 'claimed',
  });
});

test('[A2, N26] a person request receipt refreshes cached state without an event', async (t) => {
  let builds = 0;
  const box = await httpBox(t, { onStateBuild: () => { builds += 1; } });
  const first = await box.call(box.path + '/state');
  assert.equal(first.status, 200);
  assert.equal(builds, 1);

  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let eventCountBefore;
  let eventCountAfter;
  try {
    eventCountBefore = board.db.prepare('SELECT COUNT(*) AS count FROM event').get().count;
    const document = preparePersonRequest({ verb: 'add', args: { lane: 'app', title: 'Private receipt fixture' } }, 'cache-receipt-1');
    assert.equal(receivePersonRequest(board, document, {
      sequence: 1, at: new Date().toISOString(), sender: { kind: 'person', userId: 'private-fixture-person' },
    }).status, 'waiting');
    eventCountAfter = board.db.prepare('SELECT COUNT(*) AS count FROM event').get().count;
  } finally { store.closeBoard(board); }
  assert.equal(eventCountAfter, eventCountBefore, 'ordinary person request receipt intake writes no board event');

  const refreshed = await box.call(box.path + '/state');
  assert.ok(refreshed.document.state.personRequests.some((request) => request.id === 'cache-receipt-1'),
    'the next state response includes the receipt received after the previous cache fill');
  assert.equal(builds, 2, 'request-receipt metadata invalidates the state snapshot');
});

test('[A2] local HTTP state accepts a safe seen cursor and committed code previews', async (t) => {
  const box = await httpBox(t);
  box.cli(box.root, 'shout', 'app', 'state cursor baseline');
  const before = await box.call(box.path + '/state');
  const seen = before.document.state.shouts.at(-1).shout_id;
  box.cli(box.root, 'shout', 'app', 'state cursor event');
  const state = await box.call(box.path + '/state?seen=' + seen);
  assert.equal(state.document.state.unseen.since, seen);
  assert.equal(state.document.state.unseen.count, 1);
  const missing = await box.call(box.path + '/state');
  assert.equal(missing.document.state.unseen, null);
  for (const cursor of ['', '-1', '1.5', '9007199254740992']) {
    const invalid = await box.call(box.path + '/state?seen=' + cursor);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.document.error.code, 'BAD_CURSOR');
  }

  writeFileSync(join(box.root, 'SPEC.md'), '# changed working tree\n');
  const preview = await box.call(box.path + '/code?ref=' + encodeURIComponent('SPEC.md:1-4@' + box.commit) + '&before=' + encodeURIComponent('Please inspect '));
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.document.code.lines, ['# HTTP fixture', '', '## Goals', '- G1 [approved, must] Keep the board. | gate: true']);
  assert.equal(preview.document.code.path, 'SPEC.md');
  assert.equal(preview.document.code.from, 1);
  assert.equal(preview.document.code.to, 4);
  for (const ref of ['../outside:1@' + box.commit, 'SPEC.md:0@' + box.commit, 'SPEC.md:1@HEAD']) {
    const invalid = await box.call(box.path + '/code?ref=' + encodeURIComponent(ref));
    assert.equal(invalid.status, 400);
    assert.ok(['BAD_REF', 'NO_COMMIT'].includes(invalid.document.error.code));
  }
});

test('[A2, N33, N35] API listing refreshes live labels and preserves unreadable-entry warnings', async (t) => {
  const box = fixture(t);
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  const second = join(box.dir, 'second-repo');
  mkdirSync(second);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: second, env: box.env, stdio: 'pipe' });
  box.cli(second, 'init');
  const secondConfigFile = join(second, 'pullboard.json');
  const secondConfig = JSON.parse(readFileSync(secondConfigFile, 'utf8'));
  writeFileSync(secondConfigFile, JSON.stringify({ ...secondConfig, name: 'Saved second', project: 'Saved group' }));
  registerProject(second, new Date('2026-02-03T04:05:06.000Z'));

  const api = await serveApi({ runCommand: main });
  t.after(() => api.close());
  const url = new URL(api.url);
  const key = url.searchParams.get('k');
  /** Fetch the authenticated board catalog through the real local HTTP server. */
  async function listing() {
    const response = await fetchFresh(url.origin + '/api/v1/boards', { headers: { 'x-pullboard-key': key } });
    assert.equal(response.status, 200);
    return response.json();
  }

  const initial = await listing();
  assert.deepEqual(initial.boards.map((entry) => entry.root), [box.root, second]);
  assert.deepEqual(initial.warnings, []);
  const firstId = initial.boards[0].id;
  const firstAdded = initial.boards[0].added;
  const secondId = initial.boards[1].id;
  const secondAdded = initial.boards[1].added;
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, name: 'Fresh first', project: 'Fresh group' }));

  const refreshedBoth = await listing();
  assert.deepEqual(refreshedBoth.boards.map(({ root }) => root), [box.root, second]);
  assert.deepEqual(refreshedBoth.boards.map(({ id }) => id), [firstId, secondId]);
  assert.deepEqual(refreshedBoth.boards.map(({ added }) => added), [firstAdded, secondAdded]);
  assert.deepEqual(refreshedBoth.boards.map(({ name, project }) => ({ name, project })), [
    { name: 'Fresh first', project: 'Fresh group' },
    { name: 'Saved second', project: 'Saved group' },
  ]);
  rmSync(join(second, '.git'), { recursive: true, force: true });

  const refreshed = await listing();
  assert.deepEqual(refreshed.boards.map(({ root, name, project }) => ({ root, name, project })), [
    { root: box.root, name: 'Fresh first', project: 'Fresh group' },
  ]);
  assert.equal(refreshed.boards[0].id, firstId);
  assert.equal(refreshed.boards[0].added, firstAdded);
  assert.equal(refreshed.warnings.length, 1);
  assert.equal(refreshed.warnings[0].root, second);
  assert.equal(refreshed.warnings[0].name, 'Saved second');
  assert.equal(refreshed.warnings[0].project, 'Saved group');
  assert.equal(refreshed.warnings[0].added, secondAdded);
  assert.equal(refreshed.warnings[0].error.version, 1);
  assert.equal(refreshed.warnings[0].error.error.code, 'BOARD_UNAVAILABLE');
  assert.match(refreshed.warnings[0].error.error.next, /pullboard forget/);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root }) => root), [box.root, second]);

  const forgotten = box.cli(box.root, 'forget', box.root);
  assert.equal(forgotten.root, box.root);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root }) => root), [second]);
  const afterForget = await listing();
  assert.deepEqual(afterForget.boards, []);
  assert.deepEqual(afterForget.warnings.map(({ root }) => root), [second]);
});

test('[A2] real HTTP state, moves and refusals use the CLI and exact committed events', async (t) => {
  const box = await httpBox(t);
  const one = box.cli(box.root, 'worktree', 'app');
  const two = box.cli(box.root, 'worktree', 'app');
  const added = await box.call(box.path + '/moves', { verb: 'add', args: { lane: 'app', title: 'HTTP item', criterion: 'complete', specs: 'G1' } });
  assert.equal(added.status, 200);
  assert.equal(added.document.event.event_kind, 'add');
  const id = added.document.result.item.item_id;
  const claimed = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: one.agent });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.document.event.event_by, one.agent);
  assert.equal(claimed.document.event.event_kind, 'claim');
  const refused = await box.call(box.path + '/moves', { verb: 'claim', item: id, agent: two.agent });
  const terminal = box.run(two.path, 'claim', String(id), '--json');
  assert.equal(refused.status, 409);
  assert.equal(terminal.status, 1);
  assert.equal(refused.document.error.code, JSON.parse(terminal.stdout).error.code);
  assert.deepEqual(refused.document.error, JSON.parse(terminal.stdout).error, 'the original CLI refusal keeps its message and next step');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.board, box.id);
  assert.equal(state.document.state.items.find((item) => item.id === id).claim.by, one.agent);
  assert.equal((await box.call(box.path + '/items/' + id)).document.item.owner, one.agent);
  const events = await box.call(box.path + '/events?after=' + added.document.event.event_id);
  assert.deepEqual(events.document.events, [claimed.document.event]);
  const badAgent = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: 'absent-agent' });
  assert.equal(badAgent.status, 409);
  assert.equal(badAgent.document.error.code, 'NO_AGENT');
  const submitted = await box.call(box.path + '/moves', { verb: 'submit', item: id, agent: one.agent });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.document));
  const review = await box.call(box.path + '/moves', { verb: 'next', agent: two.agent, args: { verify: true } });
  assert.equal(review.status, 200, JSON.stringify(review.document));
  assert.equal(review.document.result.item.item_id, id);
  const missingNote = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: two.agent });
  assert.equal(missingNote.status, 409);
  assert.equal(missingNote.document.error.code, 'NOTE_REQUIRED');
  const release = await box.call(box.path + '/moves', { verb: 'release', item: id, agent: two.agent, args: { note: 'reviewed the wrong tree' } });
  assert.equal(release.status, 200, JSON.stringify(release.document));
  assert.deepEqual(JSON.parse(release.document.event.event_detail), { review: true, reason: 'reviewed the wrong tree', model: 'Test Model' });
});

test('[A2,V2,H16] board-state JSON retains pending and red baselines and removes cleared observations', async (t) => {
  const box = await httpBox(t);
  const pending = { command: 'true', main: box.commit, result: 'pending', request: randomUUID() };
  const board = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let id;
  try {
    id = store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Captured API observation',
      check: pending.command, checkBaseline: pending });
  } finally { store.closeBoard(board); }
  const initial = await box.call(box.path + '/items/' + id);
  assert.deepEqual(initial.document.item.checkBaseline, pending,
    'a pending captured request reaches the public state endpoint before completion');
  const completed = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.completeCheckBaseline(completed, id, { agentId: 'coordinator', expected: pending,
      baseline: { command: pending.command, main: pending.main, result: 'red', seconds: 1 } });
  } finally { store.closeBoard(completed); }
  const redState = await box.call(box.path + '/items/' + id);
  const red = redState.document.item.checkBaseline;
  assert.deepEqual(red, { command: pending.command, main: pending.main, result: 'red', seconds: 1, request: pending.request });
  assert.equal(Object.hasOwn(red, 'warning'), false, 'a failing baseline has no proves-nothing warning');
  const cleared = await box.call(box.path + '/moves', { verb: 'edit', item: id, args: { check: '' } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.document));
  const clearedState = await box.call(box.path + '/items/' + id);
  const clearedItem = clearedState.document.item;
  assert.equal(clearedItem.check, '');
  assert.equal(Object.hasOwn(clearedItem, 'checkBaseline'), false, 'clearing the check removes its old observation from API state');
});

test('[A2,V2] HTTP add and edit preserve explicit blocking baseline requests', async (t) => {
  const box = await httpBox(t);
  /** Build a finite check whose completion can be observed independently of the HTTP response. */
  function completedCheck(marker) {
    const script = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'finished')`;
    return `${shellWord(process.execPath)} -e ${shellWord(script)}`;
  }
  const firstMarker = join(box.dir, 'add-finished');
  const check = completedCheck(firstMarker);
  const added = await box.call(box.path + '/moves', { verb: 'add', args: {
    lane: 'app', title: 'Blocking API check', check, wait: true,
  } });
  assert.equal(added.status, 200, JSON.stringify(added.document));
  const item = added.document.result.item;
  assert.equal(item.item_check_baseline.result, 'green', '--wait returns a terminal observation in the add response');
  assert.equal(item.item_check_baseline.warning, 'CRITERION_PROVES_NOTHING');
  assert.equal(readFileSync(firstMarker, 'utf8'), 'finished');
  const addedState = await box.call(box.path + '/items/' + item.item_id);
  const projected = addedState.document.item;
  assert.equal(projected.check, check);
  assert.deepEqual(projected.checkBaseline, item.item_check_baseline, 'board-state item JSON carries the same complete observation and warning');
  const secondMarker = join(box.dir, 'edit-finished');
  const editedCheck = completedCheck(secondMarker);
  const edited = await box.call(box.path + '/moves', { verb: 'edit', item: item.item_id, args: {
    check: editedCheck, wait: true,
  } });
  assert.equal(edited.status, 200, JSON.stringify(edited.document));
  assert.equal(edited.document.result.item.item_check_baseline.command, editedCheck);
  assert.equal(edited.document.result.item.item_check_baseline.result, 'green', '--wait also blocks edit until its new check finishes');
  assert.equal(readFileSync(secondMarker, 'utf8'), 'finished');
  const editedState = await box.call(box.path + '/items/' + item.item_id);
  const editedItem = edited.document.result.item;
  assert.deepEqual(editedState.document.item.checkBaseline,
    editedItem.item_check_baseline, 'board-state JSON replaces the observation when the check changes');
});

test('[A2, H12, R2] requests and shouts append events and requests stay outside decisions', async (t) => {
  const box = await viewHttpBox(t);
  const requested = await box.call(box.path + '/requests', { text: 'Please approve the fixture row.' });
  assert.equal(requested.status, 200);
  assert.equal(requested.document.result.request, true);


  assert.equal(requested.document.event.event_kind, 'shout');
  const shout = await box.call(box.path + '/moves', { verb: 'shout', args: { to: 'app', text: 'new work' } });
  assert.equal(shout.document.event.event_kind, 'shout');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.requests.length, 1);
  assert.equal(state.document.state.decisions.length, 0);
  const premature = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'I am working on it' } });
  assert.equal(premature.status, 409);
  assert.equal(premature.document.error.code, 'REQUEST_OUTCOME');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 1);
  const answer = await box.call(box.path + '/moves', { verb: 'answer', item: requested.document.result.id, args: { text: 'done checked and recorded' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.document.event.event_kind, 'answer');
  assert.equal((await box.call(box.path + '/state')).document.state.requests.length, 0);
});

test('[A2] a live HTTP stream follows CLI writes and reconnects after Last-Event-ID', async (t) => {
  const box = await httpBox(t);
  const initial = await box.call(box.path + '/events');
  const after = initial.document.events.at(-1).event_id;
  const controller = new AbortController();
  const response = await fetchFresh(box.origin + box.path + '/events?after=' + after, { headers: { 'x-pullboard-key': box.key, accept: 'text/event-stream' }, signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  let buffered = '';
  /** Read a complete live event with a bounded timeout. */
  async function frame() {
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      while (!/\ndata: .+\n\n/.test(buffered)) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'stream stays open until its event arrives');
        buffered += new TextDecoder().decode(value);
      }
      const match = /id: (\d+)\ndata: (.+)\n\n/.exec(buffered);
      assert.ok(match);
      buffered = buffered.slice(match.index + match[0].length);
      return { id: Number(match[1]), document: JSON.parse(match[2]) };
    } finally { clearTimeout(timeout); }
  }
  const added = box.cli(box.root, 'add', 'app', 'Terminal event', '--criterion', 'done', '--specs', 'G1');
  const live = await frame();
  assert.equal(live.document.version, 1);
  assert.equal(live.document.event.event_kind, 'add');
  assert.equal(live.document.event.item_id, added.item.item_id);
  assert.equal(live.id, live.document.event.event_id);
  await reader.cancel();
  controller.abort();
  const replay = await fetchFresh(box.origin + box.path + '/events?after=0', { headers: { 'x-pullboard-key': box.key, 'last-event-id': String(live.id) } });
  assert.deepEqual((await replay.json()).events, []);
  const invalid = await box.call(box.path + '/events?after=1.5');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.document.error.code, 'BAD_CURSOR');
});

test('[A2, N26] the event stream says when the board changes without a move', async (t) => {
  const external = fixture(t);
  const externalConfigPath = join(external.root, 'pullboard.json');
  writeFileSync(externalConfigPath, JSON.stringify({ ...JSON.parse(readFileSync(externalConfigPath, 'utf8')), name: 'Roadmap fixture' }));
  runFixtureGit(['commit', '-q', '-m', 'chore: name the roadmap fixture', '--', 'pullboard.json'], { cwd: external.root, env: external.env, stdio: 'pipe' });
  const externalAdded = external.cli(external.root, 'add', 'app', 'Roadmap item', '--criterion', 'remain open', '--specs', 'G1');
  const externalAgent = external.cli(external.root, 'worktree', 'app', '--model', 'fixture-agent');
  const box = await httpBox(t, { additionalProjects: [{ root: external.root, name: 'Roadmap fixture' }] });
  // The roadmap resolves other repos through this machine's registry, as an export does.
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (priorHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = priorHome; });
  registerProject(external.root);
  const boardListing = await box.call('/api/v1/boards');
  const externalId = boardListing.document.boards.find((entry) => resolve(entry.root) === resolve(external.root)).id;
  const configPath = join(box.root, 'pullboard.json');
  const specPath = join(box.root, 'SPEC.md');
  const doctrinePath = join(box.root, 'DOCTRINE.md');
  box.cli(box.root, 'milestone', 'add', 'External work', '--items', `Roadmap fixture#${externalAdded.item.item_id}`);
  box.cli(box.root, 'shout', 'all', 'mark this after the stream starts');
  const agent = box.cli(box.root, 'worktree', 'app', '--model', 'fixture-agent');
  const leaseItem = box.cli(box.root, 'add', 'app', 'Expiring stream claim', '--criterion', 'becomes open', '--specs', 'G1').item;
  const localClaim = await box.call(box.path + '/moves', { verb: 'claim', item: leaseItem.item_id, agent: agent.agent });
  assert.equal(localClaim.status, 200);
  const leaseUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const db = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    db.db.prepare('UPDATE item SET item_lease_until = ? WHERE item_id = ?')
      .run(leaseUntil, leaseItem.item_id);
  } finally { store.closeBoard(db); }
  const initial = await box.call(box.path + '/events');
  const after = initial.document.events.at(-1).event_id;
  const controller = new AbortController();
  const response = await fetchFresh(box.origin + box.path + '/events?after=' + after, {
    headers: { 'x-pullboard-key': box.key, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let buffered = '';
  let pendingFrame;
  let closing = false;
  let streamClosed = false;
  /** Stop the live response and settle any pending frame read on both pass and failure paths. */
  async function closeStream() {
    if (streamClosed) return;
    streamClosed = true;
    closing = true;
    controller.abort();
    await reader.cancel().catch(() => {});
    await pendingFrame?.catch(() => {});
  }
  t.after(closeStream);
  /** Read and parse the next complete server-sent-event frame. */
  async function readFrame() {
    while (true) {
      const boundary = buffered.indexOf('\n\n');
      if (boundary >= 0) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (raw.startsWith(':')) continue;
        const event = /^event: (.+)$/m.exec(raw)?.[1] ?? 'message';
        const id = /^id: (\d+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (data !== undefined) return { event, id: id === undefined ? null : Number(id), data: JSON.parse(data) };
        continue;
      }
      const { value, done } = await reader.read();
      if (done && closing) return { event: 'closed', id: null, data: null };
      assert.equal(done, false, 'the live stream remains open while the board is served');
      buffered += new TextDecoder().decode(value);
    }
  }
  /** Share a pending frame read across timeouts so a quiet-period check cannot consume a later frame. */
  function nextFrame() {
    if (!pendingFrame) pendingFrame = readFrame().finally(() => { pendingFrame = null; });
    return pendingFrame;
  }
  /** Require an unchanged view to remain silent for longer than one server poll. */
  async function quietPeriod() {
    const extra = await Promise.race([nextFrame().then((value) => ({ value })), new Promise((resolve) => setTimeout(() => resolve(null), 350))]);
    assert.equal(extra, null, 'a quiet interval produces no duplicate or unrelated frame');
  }
  /** Require exactly one changed notification for the most recent input change. */
  async function changedOnce(label) {
    const frame = await Promise.race([
      nextFrame(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`changed event did not arrive within two seconds (${label})`)), 2000)), // budget: #554's criterion bounds a changed event at two seconds.
    ]);
    assert.equal(frame.event, 'changed');
    assert.equal(frame.id, null, 'a state notification does not advance the append-only event cursor');
    assert.deepEqual(frame.data, { version: 1, event: { event_kind: 'changed' } });
    await quietPeriod();
  }

  await quietPeriod();

  writeFileSync(specPath, readFileSync(specPath, 'utf8') + '\nThe served board follows this file.\n');
  await changedOnce('SPEC.md');

  writeFileSync(doctrinePath, '# Doctrine\n\nKeep the board honest.\n');
  await changedOnce('DOCTRINE.md');

  writeFileSync(configPath, JSON.stringify(JSON.parse(readFileSync(configPath, 'utf8')), null, 2) + '\n');
  await changedOnce('pullboard.json');

  // Committing the edited files moves HEAD alone: their bytes and stats are already seen.
  runFixtureGit(['commit', '-q', '-m', 'chore(test): move fixture head', '--', 'SPEC.md', 'DOCTRINE.md', 'pullboard.json'], { cwd: box.root, env: box.env, stdio: 'pipe' });
  await changedOnce('head');

  const externalClaim = await box.call('/api/v1/boards/' + externalId + '/moves', { verb: 'claim', item: externalAdded.item.item_id, agent: externalAgent.agent });
  assert.equal(externalClaim.status, 200);
  await changedOnce('external-claim');

  const unavailableRoot = external.root + '.temporarily-unavailable';
  renameSync(external.root, unavailableRoot);
  await changedOnce('external-unavailable');
  renameSync(unavailableRoot, external.root);
  await changedOnce('external-restored');

  const localBoardPath = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const cursorBefore = store.openBoard(localBoardPath);
  let beforeSeen;
  let beforeEvent;
  let beforeHistory;
  let deliveryEvent;
  try {
    beforeSeen = store.listAgents(cursorBefore).find((entry) => entry.agent_id === agent.agent).agent_last_shout_id;
    beforeEvent = cursorBefore.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
    beforeHistory = cursorBefore.db.prepare('SELECT * FROM event ORDER BY event_id').all();
  } finally { store.closeBoard(cursorBefore); }
  box.cli(agent.path, 'inbox');
  const cursorAfter = store.openBoard(localBoardPath);
  try {
    const afterSeen = store.listAgents(cursorAfter).find((entry) => entry.agent_id === agent.agent).agent_last_shout_id;
    const afterEvent = cursorAfter.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
    assert.ok(afterSeen > beforeSeen, 'the joined agent inbox advances its shout cursor');
    const delivered = cursorAfter.db.prepare('SELECT event_by,event_kind,item_id,event_detail FROM event WHERE event_id>? ORDER BY event_id').all(beforeEvent);
    deliveryEvent = { ...cursorAfter.db.prepare('SELECT * FROM event WHERE event_id=?').get(afterEvent) };
    assert.equal(afterEvent, beforeEvent + 1, 'inbox records exactly its landed native delivery receipt');
    assert.deepEqual(delivered.map(row => ({ by: row.event_by, kind: row.event_kind, item: row.item_id, detail: JSON.parse(row.event_detail) })), [{
      by: agent.agent, kind: 'activity-delivered', item: null,
      detail: { interrupts: [], through: beforeEvent, observedThrough: beforeEvent, digestThrough: beforeEvent, model: 'fixture-agent' },
    }], 'only the attributed receipt for the observed prefix is appended, without an acknowledgement or item move');
    assert.deepEqual(cursorAfter.db.prepare('SELECT * FROM event WHERE event_id<=? ORDER BY event_id').all(beforeEvent), beforeHistory,
      'the delivered receipt never rewrites the existing native history');
  } finally { store.closeBoard(cursorAfter); }
  const deliveryFrame = await nextFrame();
  assert.equal(deliveryFrame.event, 'message', 'the appended native delivery receipt travels before its state notification');
  assert.equal(deliveryFrame.id, deliveryEvent.event_id, 'the receipt advances the append-only stream cursor exactly once');
  assert.deepEqual(deliveryFrame.data, { version: 1, event: deliveryEvent }, 'the stream carries the complete actual native receipt');
  await changedOnce('seen-cursor');

  const clockNow = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: clockNow });
  t.mock.timers.tick(Date.parse(leaseUntil) - clockNow + 1);
  await changedOnce('lease-expiry');

  const evented = box.cli(box.root, 'add', 'app', 'Event plus state notification', '--criterion', 'both frames arrive', '--specs', 'G1');
  const eventFrame = await nextFrame();
  assert.equal(eventFrame.event, 'message');
  assert.equal(eventFrame.data.event.event_kind, 'add');
  assert.equal(eventFrame.data.event.item_id, evented.item.item_id);
  await changedOnce('ordinary-event-state');

  await closeStream();
});

/** Read a many-board event id as one cursor per board. */
function boardCursorMap(id) {
  return Object.fromEntries(id.split(',').map((pair) => {
    const [, board, sequence] = /^(.+):(\d+)$/.exec(pair);
    return [board, Number(sequence)];
  }));
}

test('[A2, N26] one event stream serves many boards', async (t) => {
  const other = fixture(t);
  const box = await httpBox(t, { additionalProjects: [{ root: other.root, name: 'Second fixture' }] });
  const listing = await box.call('/api/v1/boards');
  const otherId = listing.document.boards.find((entry) => resolve(entry.root) === resolve(other.root)).id;
  const boards = [box.id, otherId];
  const latest = async (id) => (await box.call('/api/v1/boards/' + id + '/events')).document.events.at(-1).event_id;
  const start = { [box.id]: await latest(box.id), [otherId]: await latest(otherId) };
  const headers = { 'x-pullboard-key': box.key };
  const many = box.origin + '/api/v1/events?boards=' + boards.join(',');
  /** A frame of this kind for this board, and for one item when given. */
  const is = (event, board, item) => (frame) => frame.event === event && frame.data.board === board
    && (item === undefined || frame.data.event.item_id === item);

  const first = await liveFrames(t, many + '&after=' + encodeURIComponent(boards.map((id) => id + ':' + start[id]).join(',')), headers);
  await first.quiet('both boards unchanged');

  // A move on each board arrives on the one connection, tagged with that board, with its changed signal.
  const moves = [];
  let lastId = null;
  for (const [board, cli, root] of [[box.id, box.cli, box.root], [otherId, other.cli, other.root]]) {
    const added = cli(root, 'add', 'app', 'Move on ' + board, '--criterion', 'arrives tagged', '--specs', 'G1').item;
    const frames = await first.until(board, is('message', board, added.item_id), is('changed', board));
    assert.deepEqual(frames.map((frame) => frame.data.board), frames.map(() => board), 'every frame names the board that moved');
    const event = frames.find((frame) => frame.event === 'message');
    assert.equal(event.data.version, 1);
    assert.equal(event.data.event.event_kind, 'add');
    lastId = event.id;
    assert.equal(boardCursorMap(lastId)[board], event.data.event.event_id, 'the id carries this board at its new sequence');
    assert.deepEqual(Object.keys(boardCursorMap(lastId)).sort(), [...boards].sort(), 'the id carries one cursor per followed board');
    moves.push(event.data.event.event_id);
    await first.quiet('after the move on ' + board);
  }
  assert.deepEqual(boardCursorMap(lastId), { [box.id]: moves[0], [otherId]: moves[1] });

  // An edit that writes no event sends the changed signal for that board alone, with no id.
  writeFileSync(join(other.root, 'SPEC.md'), readFileSync(join(other.root, 'SPEC.md'), 'utf8') + '\nThe second board follows this file.\n');
  const edited = await first.until('eventless edit', is('changed', otherId));
  assert.deepEqual(edited.map(({ event, id, data }) => ({ event, id, data })), [
    { event: 'changed', id: null, data: { version: 1, board: otherId, event: { event_kind: 'changed' } } },
  ]);
  await first.quiet('after the eventless edit');
  await first.close();

  // Resuming from the last id picks up each board where it left off, and nothing earlier.
  const missed = [
    box.cli(box.root, 'add', 'app', 'Missed on the first board', '--criterion', 'replays', '--specs', 'G1').item.item_id,
    other.cli(other.root, 'add', 'app', 'Missed on the second board', '--criterion', 'replays', '--specs', 'G1').item.item_id,
  ];
  const resumed = await liveFrames(t, many, { ...headers, 'last-event-id': lastId });
  const replay = await resumed.until('resume', is('message', box.id, missed[0]), is('message', otherId, missed[1]));
  assert.deepEqual(replay.map((frame) => [frame.event, frame.data.board, frame.data.event.item_id]), [
    ['message', box.id, missed[0]],
    ['message', otherId, missed[1]],
  ], 'the resume replays only what each board wrote after its cursor');
  assert.deepEqual(boardCursorMap(replay.at(-1).id), { [box.id]: replay[0].data.event.event_id, [otherId]: replay[1].data.event.event_id });
  await resumed.quiet('after the resume');
  await resumed.close();

  // A board the caller cannot read is refused by name, and nothing streams.
  const missing = 'f'.repeat(32);
  const refused = await box.call('/api/v1/events?boards=' + box.id + ',' + missing, undefined, { accept: 'text/event-stream' });
  assert.equal(refused.status, 404);
  assert.equal(refused.document.error.code, 'NO_BOARD');
  assert.match(refused.document.error.message, new RegExp(missing));
  const repeated = await box.call('/api/v1/events?boards=' + box.id + ',' + box.id, undefined, { accept: 'text/event-stream' });
  assert.equal(repeated.status, 400);
  assert.match(repeated.document.error.message, new RegExp(box.id));
});

test('[A2,N39] the view cookie check catches a weakened compare', async (t) => {
  const box = fixture(t);
  const secret = randomUUID();
  const sessionCookie = {
    name: `pullboard_view_${randomUUID().replaceAll('-', '')}`,
    value: randomBytes(24).toString('base64url'),
  };
  assert.throws(() => createLocalApiHandler({
    secret,
    getPort: () => 1,
    runCommand: main,
    projects: () => [],
    sessionCookie: { name: sessionCookie.name, value: randomBytes(8).toString('base64url') },
  }), /at least 128 bits/u, 'session cookies need capacity for at least 128 random bits');
  let bound;
  const handler = createLocalApiHandler({
    secret,
    getPort: () => bound,
    runCommand: main,
    projects: () => [{ root: box.root, name: 'Cookie fixture' }],
    personChannel: 'api',
    sessionCookie,
  });
  const server = createServer(handler);
  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { bound = server.address().port; ready(); });
  });
  t.after(() => new Promise((closed) => server.close(closed)));
  const origin = `http://127.0.0.1:${bound}`;
  const otherPortServer = createServer();
  await new Promise((ready, fail) => {
    otherPortServer.once('error', fail);
    otherPortServer.listen(0, '127.0.0.1', ready);
  });
  const otherLocalOrigin = `http://127.0.0.1:${otherPortServer.address().port}`;
  t.after(() => new Promise((closed) => otherPortServer.close(closed)));
  assert.notEqual(otherLocalOrigin, origin, 'the hostile same-site page uses a different localhost port');
  const cookie = `${sessionCookie.name}=${sessionCookie.value}`;
  /** Send one real HTTP request to the private API handler. */
  const request = (path, headers = {}, init = {}) => fetchFresh(origin + path, {
    ...init,
    headers: { ...headers, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  /** Decode the handler's versioned refusal and check its authentication result. */
  async function refused(response, status, code = 'AUTH_REQUIRED') {
    assert.equal(response.status, status);
    const document = await response.json();
    assert.equal(document.version, 1);
    assert.equal(document.error.code, code);
  }

  const cookieListing = await request('/api/v1/boards', { cookie, 'sec-fetch-site': 'same-origin' });
  assert.equal(cookieListing.status, 200, 'the current view cookie authenticates the actual local API');
  const listing = await cookieListing.json();
  assert.equal(listing.version, 1);
  const board = listing.boards.find((entry) => resolve(entry.root) === resolve(box.root));
  assert.ok(board, 'the private Git fixture is listed through cookie authentication');
  const state = await request(`/api/v1/boards/${board.id}/state`, { cookie });
  assert.equal(state.status, 200, 'cookie-authenticated state reads the fixture SQLite board');

  const sameOriginFallback = await request('/api/v1/boards', { cookie });
  assert.equal(sameOriginFallback.status, 200, 'without Fetch-Site, the existing own Host/Origin checks still allow the cookie');
  await refused(await request('/api/v1/boards'), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${sessionCookie.name}=${'x'.repeat(sessionCookie.value.length)}` }), 401, 'AUTH_REQUIRED');
  const caseChangedName = `${sessionCookie.name[0].toUpperCase()}${sessionCookie.name.slice(1)}`;
  assert.notEqual(caseChangedName, sessionCookie.name);
  await refused(await request('/api/v1/boards', { cookie: `${caseChangedName}=${sessionCookie.value}` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${sessionCookie.name}=expired-session-value` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${cookie}; ${cookie}` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${sessionCookie.name}=wrong-cookie-value; ${cookie}` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie: `${sessionCookie.name}; ${cookie}` }), 401, 'AUTH_REQUIRED');
  const staleName = `${sessionCookie.name}_old`;
  await refused(await request('/api/v1/boards', { cookie: `${staleName}=${sessionCookie.value}` }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie, 'sec-fetch-site': 'same-site' }), 401, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie, origin: otherLocalOrigin, 'sec-fetch-site': 'same-site' }), 401, 'AUTH_REQUIRED');
  await refused(await request(`/api/v1/boards/${board.id}/moves`, {
    cookie, 'sec-fetch-site': 'same-site',
  }, { method: 'POST', body: { verb: 'next', args: {} } }), 401, 'AUTH_REQUIRED');
  await refused(await request(`/api/v1/boards/${board.id}/moves`, {
    cookie, origin: otherLocalOrigin, 'sec-fetch-site': 'same-site',
  }, { method: 'POST', body: { verb: 'next', args: {} } }), 401, 'AUTH_REQUIRED');

  const foreignHost = await new Promise((done, reject) => {
    const outbound = httpRequest(origin + '/api/v1/boards', { headers: { host: 'foreign.invalid', cookie } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => done({ status: response.statusCode, document: JSON.parse(text) }));
    });
    outbound.once('error', reject);
    outbound.end();
  });
  assert.equal(foreignHost.status, 401, 'a valid cookie cannot cross the API host boundary');
  assert.equal(foreignHost.document.error.code, 'AUTH_REQUIRED');
  await refused(await request('/api/v1/boards', { cookie, origin: 'https://foreign.invalid' }), 403, 'API_ORIGIN');
  await refused(await request(`/api/v1/boards/${board.id}/moves`, { cookie, origin: 'https://foreign.invalid' }, {
    method: 'POST', body: { verb: 'next', args: {} },
  }), 403, 'API_ORIGIN');

  const keyHeader = await request('/api/v1/boards', { 'x-pullboard-key': secret, 'sec-fetch-site': 'cross-site' });
  assert.equal(keyHeader.status, 200, 'the existing key header remains valid');
  const bearer = await request('/api/v1/boards', { authorization: `Bearer ${secret}` });
  assert.equal(bearer.status, 200, 'the existing Bearer key remains valid');
  const queryKey = await request(`/api/v1/boards?k=${encodeURIComponent(secret)}`);
  assert.equal(queryKey.status, 200, 'the existing query key remains valid');
  const badCookieWithKey = await request('/api/v1/boards', { cookie: `${sessionCookie.name}=wrong-cookie-value`, 'x-pullboard-key': secret });
  assert.equal(badCookieWithKey.status, 200, 'a bad cookie does not override a valid key');

  const personMove = await request(`/api/v1/boards/${board.id}/moves`, { cookie }, {
    method: 'POST', body: { verb: 'next', args: { as: 'person' } },
  });
  await refused(personMove, 409, 'B26_PERSON_CHANNEL');
});

test('[A2] local auth, origin, unknown board and malformed calls refuse without moving', async (t) => {
  const box = await httpBox(t);
  const unauthenticated = await fetchFresh(box.origin + '/api/v1/boards');
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, 'AUTH_REQUIRED');
  const badSecret = await box.call('/api/v1/boards', undefined, { 'x-pullboard-key': 'incorrect-private-fixture-key' });
  assert.equal(badSecret.status, 401);
  const badOrigin = await box.call(box.path + '/requests', { text: 'blocked' }, { origin: 'https://different.invalid' });
  assert.equal(badOrigin.status, 403);
  const unknown = await box.call('/api/v1/boards/' + '0'.repeat(32) + '/state');
  assert.equal(unknown.status, 404);
  const unknownStream = await box.call('/api/v1/boards/' + '0'.repeat(32) + '/events', undefined, { accept: 'text/event-stream' });
  assert.equal(unknownStream.status, 404);
  const malformed = await fetchFresh(box.origin + box.path + '/moves', { method: 'POST', headers: { 'x-pullboard-key': box.key, 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'BAD_REQUEST');
  const unsupported = await box.call(box.path + '/moves', { verb: 'run', args: { agent: 'unsafe' } });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.document.error.code, 'BAD_REQUEST');
  const state = await box.call(box.path + '/state');
  assert.deepEqual(state.document.state.items, []);
  assert.deepEqual(state.document.state.requests, []);
});

test('[A2] move text stays literal and invalid bodies cannot produce a partial event', async (t) => {
  const box = await httpBox(t);
  const literal = await box.call(box.path + '/moves', { verb: 'shout', args: { to: 'app', text: '--help' } });
  assert.equal(literal.status, 200);
  assert.equal(literal.document.event.event_kind, 'shout');
  const state = await box.call(box.path + '/state');
  assert.equal(state.document.state.shouts.at(-1).shout_text, '--help');
  const oversized = await box.call(box.path + '/requests', { text: 'x'.repeat(110_000) });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.document.error.code, 'BAD_REQUEST');
  const wrongType = await box.call(box.path + '/requests', { text: 'refused' }, { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 400);
  const wrongHost = await new Promise((done, reject) => {
    const request = httpRequest(box.origin + '/api/v1/boards', { headers: { host: 'foreign.invalid', 'x-pullboard-key': box.key } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => done({ status: response.statusCode, document: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(wrongHost.status, 401);
  assert.equal(wrongHost.document.error.code, 'AUTH_REQUIRED');
  const after = await box.call(box.path + '/state');
  assert.deepEqual(after.document.state.events, state.document.state.events);
  assert.deepEqual(after.document.state.requests, []);
});

test('[A2] shared transport stops a live stream when its caller loses access', async (t) => {
  const box = fixture(t);
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  let authorized = true;
  let checks = 0;
  /** Read this fixture's real event records and always close its connection. */
  function records(after = 0) {
    const board = store.openBoard(file);
    try { return store.events(board).filter((event) => event.event_id > after); }
    finally { store.closeBoard(board); }
  }
  const board = store.openBoard(file);
  const id = store.boardId(board);
  store.closeBoard(board);
  const handler = createApiHandler({
    authenticate: () => {
      checks += 1;
      if (!authorized) throw new Refused('AUTH_REQUIRED', 'the fixture session was revoked; sign in again');
      return { user: 'fixture-user' };
    },
    board: () => ({ id }),
    events: (known, after) => records(after),
  }, { pollMs: 20 });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const timeout = setTimeout(() => controller.abort(), 10_000);
  t.after(() => clearTimeout(timeout));
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/events?after=' + records().at(-1).event_id, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  authorized = false;
  box.cli(box.root, 'add', 'app', 'Hidden after revocation', '--criterion', 'complete', '--specs', 'G1');
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.match(text, /event: error/);
  assert.match(text, /"version":1/);
  assert.match(text, /"code":"AUTH_REQUIRED"/);
  assert.doesNotMatch(text, /"event_kind":"add"/);
  assert.ok(checks >= 3, 'access is checked at entry and on live polls');
});

test('[A2] adapters without a committed-code capability return a versioned refusal', async (t) => {
  const handler = createApiHandler({
    authenticate: () => ({ user: 'fixture-user' }),
    boards: () => [],
    board: (id) => ({ id }),
    state: () => ({}),
    events: () => [],
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); }));
  const id = 'fixture-board';
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/code?ref=secret.txt%3A1%40abcdef0');
  const document = await response.json();
  assert.equal(response.status, 400);
  assert.equal(document.version, 1);
  assert.equal(document.error.code, 'CODE_NOT_AVAILABLE');
  assert.match(document.error.next, /local view|local API/);
  const noDelta = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + '/state?since=1');
  assert.equal(noDelta.status, 400);
  assert.equal((await noDelta.json()).error.code, 'DELTA_NOT_AVAILABLE', 'an adapter whose state carries full items offers no deltas');
  for (const path of ['/items/1', '/items?q=anything']) {
    const unavailable = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/' + id + path);
    assert.equal(unavailable.status, 400);
    assert.equal((await unavailable.json()).error.code, 'ITEM_NOT_AVAILABLE', 'an adapter whose state carries full items offers no item reads');
  }
});

test('[A2, N26] state JSON fragments preserve the API envelope and legacy adapter fallback', async (t) => {
  const state = { board: 'fixture', label: 'a ",\\"injected\\":true', unseen: null };
  const handler = createApiHandler({
    authenticate: () => ({ user: 'fixture-user' }),
    board: (id) => ({ id }),
    stateJson: (_board, _who, seen) => seen === 1 ? state : JSON.stringify(state),
    eventLogVersion: () => 'v1',
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/fixture/state');
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), { version: 1, state, eventLogVersion: 'v1' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  const invalidSerializer = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/fixture/state?seen=1');
  assert.equal(invalidSerializer.status, 500);
  assert.equal((await invalidSerializer.json()).error.code, 'SERVICE_ERROR');

  const legacy = createApiHandler({
    authenticate: () => ({ user: 'fixture-user' }),
    board: (id) => ({ id }),
    state: () => state,
  });
  const legacyServer = createServer(legacy);
  await new Promise((done) => legacyServer.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { legacy.close(); legacyServer.close(done); legacyServer.closeIdleConnections(); }));
  const legacyResponse = await fetchFresh('http://127.0.0.1:' + legacyServer.address().port + '/api/v1/boards/fixture/state');
  assert.deepEqual(await legacyResponse.json(), { version: 1, state });
  assert.equal(legacyResponse.headers.get('cache-control'), 'no-store');
  assert.equal(legacyResponse.headers.get('etag'), null);
});


test("an agent-shell serve cannot record a person's move [P6,B26]", { timeout: 60_000 }, // budget: hang ceiling for private CLI/API startup and person-channel checks, not a throughput claim.
async (t) => {
  const box = fixture(t);
  const spec = join(box.root, 'SPEC.md');
  writeFileSync(spec, readFileSync(spec, 'utf8') + '\n- G2 [pending, must] Person approval only. | gate: true\n- G3 [pending, must] Person decline only. | gate: true\n');
  runFixtureGit(['add', 'SPEC.md'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-qm', 'chore(test): prepare person-only rows'], { cwd: box.root, env: box.env });
  const item = box.cli(box.root, 'add', 'app', 'Private channel item', '--specs', 'G1', '--criterion', 'No person bypass').item.item_id;
  const decision = box.cli(box.root, 'shout', 'person', 'Choose the private fixture decision', '--decision').id;
  const child = startFixtureChild(process.execPath, [BIN, 'serve', '--port', '0', '--json'], {
    cwd: box.root, env: { ...box.env, CLAUDECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  let stopped = false;
  /** Stop only the private server and await its terminal close before deleting its fixture. */
  async function stopServer() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      const ended = await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 2000); })]);
      if (!ended) { child.kill('SIGKILL'); await closed; }
    } finally { clearTimeout(timer); }
  }
  t.after(stopServer);
  const served = await new Promise((resolveAddress, rejectAddress) => {
    let output = '';
    const timer = setTimeout(() => rejectAddress(new Error('private agent serve did not announce its address')), 20_000);
    child.once('exit', () => { clearTimeout(timer); rejectAddress(new Error('private agent serve exited before its address')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      try {
        const document = JSON.parse(output);
        if (typeof document.url === 'string') { clearTimeout(timer); resolveAddress(new URL(document.url)); }
      } catch { /* Wait for the complete private JSON announcement, never print its key. */ }
    });
  });
  const headers = { 'x-pullboard-key': served.searchParams.get('k'), 'content-type': 'application/json' };
  const listing = await (await fetchFresh(served.origin + '/api/v1/boards', { headers })).json();
  const id = listing.boards.find(board => resolve(board.root) === resolve(box.root)).id;
  const path = '/api/v1/boards/' + id;
  const before = box.cli(box.root, 'log').events.length;
  const attempts = [
    { verb: 'spec-approve', args: { ids: 'G2' } },
    { verb: 'spec-decline', args: { ids: 'G3', reason: 'Not approved by a person' } },
    { verb: 'answer', item: decision, args: { text: 'Forged person answer', as: 'person' } },
    { verb: 'verify', item, args: { decision: 'accept', as: 'person', note: 'Forged person verification' } },
    { verb: 'next', args: { as: 'person' } },
  ];
  for (const move of attempts) {
    const response = await fetchFresh(served.origin + path + '/moves', { method: 'POST', headers, body: JSON.stringify(move) });
    const document = await response.json();
    assert.equal(document.error?.code, 'B26_PERSON_CHANNEL', move.verb + ' never receives person authority from an API key');
    assert.notEqual(response.status, 200);
    assert.equal(box.cli(box.root, 'log').events.length, before, move.verb + ' records no event');
  }
  const tokenResponse = await fetchFresh(served.origin + path + '/tokens', { method: 'POST', headers, body: JSON.stringify({ id: randomUUID() }) });
  assert.equal((await tokenResponse.json()).error?.code, 'B26_PERSON_CHANNEL', 'API token management has no person authority either');
  assert.equal(box.cli(box.root, 'log').events.length, before);
  await stopServer();
  // Denial belongs to the interface, even when the server has no agent-shell marker.
  const plain = await serveApi({ port: 0, runCommand: main, projects: () => [{ root: box.root, name: 'Plain API fixture' }] });
  t.after(() => plain.close());
  const plainAddress = new URL(plain.url);
  const plainReply = await fetchFresh(plainAddress.origin + path + '/moves', {
    method: 'POST', headers: { 'x-pullboard-key': plainAddress.searchParams.get('k'), 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G2' } }),
  });
  assert.equal((await plainReply.json()).error?.code, 'B26_PERSON_CHANNEL', 'an ordinary-shell API has no person authority');
  assert.equal(box.cli(box.root, 'log').events.length, before);
  registerProject(box.root);
  const view = await serveView({ port: 0 });
  t.after(() => view.close());
  const viewAddress = new URL(view.url);
  const response = await fetchFresh(viewAddress.origin + path + '/moves', {
    method: 'POST', headers: { 'x-pullboard-key': viewAddress.searchParams.get('k'), 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G2' } }),
  });
  assert.equal(response.status, 200, 'the actual view keeps the person channel');
  const approved = (await response.json()).event;
  assert.equal(approved.event_by, 'person');
  assert.equal(box.cli(box.root, 'log').events.length, before + 1);
});

test("a request through serve is never the person's [P6,B26,A2]", { timeout: 60_000 }, // budget: private CLI/API startup and request-channel checks, not a throughput claim.
async (t) => {
  const box = fixture(t);
  const child = startFixtureChild(process.execPath, [BIN, 'serve', '--port', '0', '--json'], {
    cwd: box.root, env: { ...box.env, CLAUDECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed));
  let stopped = false;
  /** Stop only the private server and await its terminal close before deleting its fixture. */
  async function stopServer() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    try {
      const ended = await Promise.race([closed.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 2000); })]); // budget: owned fixture server TERM grace before its bounded KILL fallback.
      if (!ended) { child.kill('SIGKILL'); await closed; }
    } finally { clearTimeout(timer); }
  }
  t.after(stopServer);
  const served = await new Promise((resolveAddress, rejectAddress) => {
    let output = '';
    const timer = setTimeout(() => rejectAddress(new Error('private agent serve did not announce its address')), 20_000); // budget: private CLI address startup ceiling.
    child.once('exit', () => { clearTimeout(timer); rejectAddress(new Error('private agent serve exited before its address')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      try {
        const document = JSON.parse(output);
        if (typeof document.url === 'string') { clearTimeout(timer); resolveAddress(new URL(document.url)); }
      } catch { /* Wait for the complete private JSON announcement, never print its key. */ }
    });
  });
  const headers = { 'x-pullboard-key': served.searchParams.get('k'), 'content-type': 'application/json' };
  const listing = await (await fetchFresh(served.origin + '/api/v1/boards', { headers })).json();
  const id = listing.boards.find(board => resolve(board.root) === resolve(box.root)).id;
  const path = '/api/v1/boards/' + id;
  const before = box.cli(box.root, 'log').events.length;
  const refused = await fetchFresh(served.origin + path + '/requests', {
    method: 'POST', headers, body: JSON.stringify({ text: 'Please review this private fixture.' }),
  });
  assert.equal((await refused.json()).error?.code, 'B26_PERSON_CHANNEL');
  assert.notEqual(refused.status, 200);
  assert.equal(box.cli(box.root, 'log').events.length, before, 'a standalone serve request adds no event');
  await stopServer();
  const view = await viewHttpBox(t, box);
  const requested = await view.call(view.path + '/requests', { text: 'Please review this from the actual view.' });
  assert.equal(requested.status, 200, "the actual view keeps the person's request channel");
  assert.equal(requested.document.event.event_by, 'person');
  assert.equal(box.cli(box.root, 'log').events.length, before + 1);
});
