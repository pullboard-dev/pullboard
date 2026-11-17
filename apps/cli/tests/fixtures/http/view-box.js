/** Private view box and repeated-read harness for the shout HTTP journeys [A2,N26]. */
import assert from 'node:assert/strict';
import { serveView } from '../../../src/io/commands/view.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import { main as nativeTestMain } from '../native.js';
import { apiHttpFixture as fixture } from '../api.js';
import { fetchFresh } from '../http.js';

export { fixture };

/** Run a private view in a child process with child-process accounting enabled only for warmed reads. */
export const REPEATED_READ_HARNESS = `
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
const { main: nativeTestMain } = await import(${JSON.stringify(new URL('../native.js', import.meta.url).href)});
const view = await serveView({ port: 0, runCommand: nativeTestMain });
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
    const { apiBoards } = await import(new URL('../../../../../packages/api/index.js', pathToFileURL(serveFile)));
    const { openBoard, openBoardForRead } = await import(new URL('../../../../../apps/lib/index.js', pathToFileURL(serveFile)));
    const apiBoardOpeners = { openBoard, openBoardForRead };
    const { withGitReadFacts } = await import(new URL('../../../../../packages/git/index.js', pathToFileURL(serveFile)));
    // A deliberately stale board stamp forces a write-open below. Warm its one-time own-PID
    // diagnostic before measuring provenance; ordinary warmed reads still require zero children.
    const { prepareBoardWriteIdentity } = await import(new URL('../../../../../packages/store/index.js', pathToFileURL(serveFile)));
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
      try { listed = withGitReadFacts(() => apiBoards(() => projects, status, apiBoardOpeners)); }
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
  /** The SPEC.md row-age commit once the view's age worker has answered: a state read answers at once with the age unknown (null) and refreshes it later, never naming the previous commit. */
  async function specAgeAt(read) {
    let latest = await read();
    const deadline = Date.now() + 20_000; // budget: the age worker walks the fixture history once, as row-ages-new-commit.test.js allows
    while (latest.rowAgesAt['SPEC.md'] === null && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 25));
      latest = await read();
    }
    return { latest, age: latest.rowAgesAt['SPEC.md'] };
  }
  writeSpec('G2');
  execFileSync('git', ['add', 'SPEC.md'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  commitFixture(target.root, 'docs: refresh fixture spec [G1]');
  let current = await state();
  let head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target.root, env: process.env, encoding: 'utf8' }).trim();
  assert.ok(current.spec.some((row) => row.id === 'G2'));
  assert.equal((await specAgeAt(state)).age, head, 'a new commit refreshes the file HEAD');

  execFileSync('git', ['switch', '-q', '-c', 'freshness-branch'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  writeSpec('G3');
  execFileSync('git', ['add', 'SPEC.md'], { cwd: target.root, env: process.env, stdio: 'ignore' });
  commitFixture(target.root, 'docs: update branch fixture spec [G1]');
  current = await state();
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target.root, env: process.env, encoding: 'utf8' }).trim();
  assert.ok(current.spec.some((row) => row.id === 'G3'));
  assert.equal((await specAgeAt(state)).age, head, 'a branch switch refreshes the selected HEAD');

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
  const linkedState = (await specAgeAt(async () => (await readApi(linkedPath)).state)).latest;
  const linkedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: linked.root, env: process.env, encoding: 'utf8' }).trim();
  assert.ok(linkedState.spec.some((row) => row.id === 'G5'));
  assert.equal(linkedState.rowAgesAt['SPEC.md'], linkedHead, 'a linked worktree branch change refreshes its state');
  process.stdout.write(JSON.stringify({ fresh: true }) + '\\n');
} finally {
  await view.close();
}
`;

/** Serve one registered private fixture through the actual person's view adapter. */
export async function viewHttpBox(t, existing = null) {
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
  view = await serveView({ port: 0, runCommand: nativeTestMain });
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
