// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-test-input source-tree */
/** Cockpit fixture checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request,
} from 'node:http';
import diagnosticsChannel from 'node:diagnostics_channel';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { waitForStableBoxes } from '../../tests/fixtures/cockpit/stable.js';
import {
  addItem,
  closeBoard,
} from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { projectState } from '../../src/io/view.js';
import { testsNeedBrowser } from '../../../../packages/gate/index.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import {
  scratch,
  machine,
  project,
  build,
  fetchView,
  fetchLive,
  startView,
  styleOf,
  openPage,
  boardId,
  boardOf,
  assertObservationsEqual,
  chromeExecutable,
  startSnapshotChrome,
  openSnapshotChrome,
  stopOwnedChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

test('the view fixture refuses to launch Chrome from an undeclared test file [C7,O5]', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-view-browser-slot-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['bin', 'machine']) mkdirSync(join(root, name));
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), root);
  // The tests under test import the cockpit harness from its place in the layout, so that folder comes along [C7].
  mkdirSync(join(root, 'test'));
  cpSync(resolve(import.meta.dirname, '../../tests/fixtures'), join(root, 'apps/cli/tests/fixtures'), { recursive: true });

  /** Exercise the actual view launcher and always stop any stand-in it owns, including a failing baseline. */
  const body = (name, binding) => `
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
${binding}
test('${name} view launch', async () => {
  appendFileSync(process.env.FIXTURE_MARKERS, '${name}=' + process.env.PULLBOARD_TEST_BROWSER_SLOT + '\\n');
  const profile = join(process.cwd(), '${name}-profile');
  mkdirSync(profile);
  let stop;
  try {
    const view = ${name === 'held' ? '{ startSnapshotChrome }' : "await import(['..', 'apps', 'cli', 'tests', 'fixtures', 'cockpit', 'harness.js'].join('/'))"};
    const browser = await view.startSnapshotChrome(process.env.FIXTURE_BROWSER, profile, { onOwned: owned => { stop = owned; } });
    await browser.stop();
  } finally { await stop?.(); }
});
`;
  writeFileSync(join(root, 'test/classified-view.test.js'), `// pullboard: browser${body('held', "import { startSnapshotChrome } from '../apps/cli/tests/fixtures/cockpit/harness.js';")}`);
  writeFileSync(join(root, 'test/hidden-view.test.js'), body('none', ''));
  const browser = join(root, 'view-browser-stand-in');
  writeFileSync(browser, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
appendFileSync(process.env.FIXTURE_LAUNCHES, basename(profile) + '\\n');
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, 'DevToolsActivePort'), '9333\\n/devtools/browser/fixture\\n');
setInterval(() => {}, 1000); // Protocol lifetime: the owner terminates this stand-in process group.
`);
  chmodSync(browser, 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key.startsWith('PULLBOARD_GATE_SLOT_') || key.startsWith('PULLBOARD_TEST_BROWSER_')) delete env[key];
  }
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_TEST_FILE', 'PULLBOARD_CHROME']) delete env[key];
  Object.assign(env, { PULLBOARD_HOME: join(root, 'home'), PULLBOARD_MACHINE_HOME: join(root, 'machine'),
    FIXTURE_BROWSER: browser, FIXTURE_MARKERS: join(root, 'markers'), FIXTURE_LAUNCHES: join(root, 'launches') });
  // A committed main, so the runner can read its accepted main for test file budgets.
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await testsNeedBrowser(root, ['test/classified-view.test.js']), true, 'the first line declares the browser');
  assert.equal(await testsNeedBrowser(root, ['test/hidden-view.test.js']), false, 'no first-line marker, no browser');
  const run = spawnSync(process.execPath, ['packages/gate/src/io/run/tests.js', 'test/classified-view.test.js', 'test/hidden-view.test.js'],
    { cwd: root, env, encoding: 'utf8' });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.notEqual(run.status, 0, output);
  assert.match(output, /\[BROWSER_UNDECLARED\] test\/hidden-view\.test\.js launched Chrome/u);
  assert.deepEqual(readFileSync(join(root, 'markers'), 'utf8').trim().split('\n').sort(), ['held=held', 'none=none']);
  assert.deepEqual(readFileSync(join(root, 'launches'), 'utf8').trim().split('\n'), ['held-profile'],
    'only the declared worker starts the stand-in; the undeclared worker never spawns it');
});


test('the cockpit fixture inits its board without a model [N26]', () => {
  const box = machine();
  project(box, 'model-free-coordinator');
  const init = box.invocations.find((call) => call.args.length === 1 && call.args[0] === 'init');
  const join = box.invocations.find((call) => call.args[0] === 'join' && call.args[1] === 'web');
  assert.ok(init, 'the fixture ran init');
  assert.equal(init.hasModel, false, 'init does not inherit the test runner model');
  assert.ok(join, 'the fixture ran a later agent join');
  assert.equal(join.hasModel, true, 'later agent joins retain the machine model');
  assert.equal(join.model, 'Test Model');
});

test('the view fixture opts out of the background view [N26]', () => {
  const box = machine();
  const originalHome = box.env.PULLBOARD_MACHINE_HOME;
  const originalFile = join(originalHome, 'settings.json');
  assert.equal(JSON.parse(readFileSync(originalFile, 'utf8')).view.background, false,
    'machine setup opts out before any CLI command runs');

  // A second machine in the same scratch root can override the effective home after machine().
  // Seed unrelated settings there to prove project() preserves them when it applies the opt-out.
  const overrideHome = join(box.dir, 'second-machine-home');
  mkdirSync(overrideHome);
  const overrideFile = join(overrideHome, 'settings.json');
  writeFileSync(overrideFile, JSON.stringify({ browserSlots: 1, view: { custom: 'keep', background: true } }));
  box.env.PULLBOARD_MACHINE_HOME = overrideHome;
  let checkedInit = false;
  const realRun = box.runWithEnv;
  /** Observe the real init boundary before delegating to the unchanged fixture CLI runner. */
  box.runWithEnv = (cwd, env, ...args) => {
    if (args[0] === 'init') {
      checkedInit = true;
      assert.equal(env.PULLBOARD_MACHINE_HOME, overrideHome, 'check the exact environment passed to init');
      assert.deepEqual(JSON.parse(readFileSync(join(env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')),
        { browserSlots: 1, view: { custom: 'keep', background: false } },
        'the effective machine opts out before the real init, without replacing its other settings');
    }
    return realRun(cwd, env, ...args);
  };
  project(box, 'background-view-opt-out');
  assert.equal(checkedInit, true, 'the fixture executes the actual init command');
  assert.equal(JSON.parse(readFileSync(originalFile, 'utf8')).view.background, false,
    'changing the effective home leaves the first private machine alone');
  assert.equal(JSON.parse(readFileSync(overrideFile, 'utf8')).view.background, false,
    'later copied or hooked CLI commands retain the effective machine opt-out');
});

test('the cockpit helper starts its view in the foreground [C7,N26]', async t => {
  const box = machine();
  project(box, 'foreground-view');
  delete box.env.PULLBOARD_VIEW_FOREGROUND;
  const receipt = join(box.dir, 'view-processes.jsonl');
  const observer = join(box.dir, 'observe-view.mjs');
  // A preload observes the real spawned Node environment without replacing the CLI or server.
  writeFileSync(observer, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(1, 4), marker: process.env.PULLBOARD_VIEW_FOREGROUND ?? null }) + '\\n', { mode: 0o600 });\n`);
  box.env.NODE_OPTIONS = `${box.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(observer).href}`.trim();
  /** Read only the PIDs and marker observed by this fixture's actual Node children. */
  const observed = () => {
    try { const seen = new Map();
      // A worker thread inside the view repeats the preload under the same pid, so count processes, not imports.
      for (const line of readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean)) { const row = JSON.parse(line); if (!seen.has(row.pid)) seen.set(row.pid, row); }
      return [...seen.values()]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  /** Stop any owned child if a failed assertion interrupted the helper's normal cleanup. */
  t.after(() => {
    for (const { pid } of observed()) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  const view = await startView(box);
  let children;
  try {
    children = observed();
    assert.equal(children.length, 1, 'the helper owns one foreground view process: ' + JSON.stringify(children));
    assert.equal(children[0].marker, '1', 'the actual spawned child receives the foreground marker');
    assert.doesNotThrow(() => process.kill(children[0].pid, 0), 'the owned child stays alive while serving');
  } finally {
    await view.stop();
  }
  assert.throws(() => process.kill(children[0].pid, 0), error => error.code === 'ESRCH',
    'stopping the helper removes its actual view process');
  await assert.rejects(fetchLive(view.link, { signal: AbortSignal.timeout(1_000) }),
    error => error.cause?.code === 'ECONNREFUSED', 'stopping the helper also closes the owned listener');
});

test('borrowed board presentation keeps parity, shows staged rows, and leaves the caller connection open [N26,H16]', () => {
  const box = machine();
  const p = project(box, 'projector');
  box.run(p.repo, 'add', 'web', 'Existing projection row', '--criterion', 'same native data');
  const source = openBoard(join(p.repo, '.git', 'pullboard', 'board.sqlite'));
  const staged = openBoard(':memory:');
  try {
    importBoard(staged, exportBoard(source));
    const ordinary = projectState(p.repo);
    assert.ok(ordinary.agents.every(agent => agent.presence === 'live' && typeof agent.heartbeatAt === 'string'),
      'real native fixture heartbeats remain visible beside the durable board');
    const borrowed = projectState(p.repo, { board: staged });
    assert.deepEqual(borrowed, { ...ordinary, agents: ordinary.agents.map(agent => ({ ...agent, heartbeatAt: null, presence: 'gone' })) },
      'borrowed projection preserves every durable field; an in-memory import has no native presence sidecar');
    const before = exportBoard(source);
    const stagedId = addItem(staged, { by: 'coordinator', lane: 'web', title: 'Staged recovery row', criterion: 'visible only in staged snapshot' });
    const stagedState = projectState(p.repo, { board: staged });
    assert.ok(stagedState.items.some(item => item.id === stagedId && item.title === 'Staged recovery row'));
    assert.ok(!projectState(p.repo).items.some(item => item.title === 'Staged recovery row'), 'staged-only rows never change the native board');
    assert.deepEqual(exportBoard(source), before, 'projection from the staged connection does not mutate source rows');
    assert.equal(staged.db.prepare('SELECT 1 AS open').get().open, 1, 'the caller-owned staged connection stays open');
  } finally {
    closeBoard(staged);
    closeBoard(source);
  }
});

test('the view reads its release notes once, not on every state [N26]', () => {
  const box = machine();
  const p = project(box, 'release-note-cache');
  box.run(p.repo, 'add', 'web', 'A real board row', '--specs', 'G1');
  const changelog = readFileSync(resolve(import.meta.dirname, '../../../../CHANGELOG.md'));
  const expectedHash = createHash('sha256').update(changelog).digest('hex');
  const serveUrl = new URL('../../src/io/view.js', import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = ${JSON.stringify(p.repo)};
const observedReads = [];
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const value = Reflect.apply(originalReadFileSync, this, [file, ...args]);
  let name = '';
  try { name = basename(file instanceof URL ? fileURLToPath(file) : String(file)); } catch { /* non-path input */ }
  if (name === 'CHANGELOG.md') {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    observedReads.push({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  }
  return value;
};
syncBuiltinESMExports();
const { projectState } = await import(${JSON.stringify(serveUrl)} + '?release-cache-regression');
const states = [projectState(repo), projectState(repo), projectState(repo)];
assert.equal(states.length, 3);
process.stdout.write(JSON.stringify({ observedReads, releaseNotes: states.map(state => state.releaseNotes) }) + '\\n');
`;
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: box.dir, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(child.status, 0, `fresh real project-state process: ${child.stderr}`);
  const observation = JSON.parse(child.stdout);
  assert.equal(observation.observedReads.length, 1, 'one successful filesystem changelog read serves multiple project states');
  assert.deepEqual(observation.observedReads[0], { sha256: expectedHash, bytes: changelog.length }, 'the read returns the unchanged shipped changelog bytes');
  assert.equal(observation.releaseNotes.length, 3, 'three real SQLite-backed project states were built');
  for (const releaseNotes of observation.releaseNotes.slice(1)) {
    assert.deepEqual(releaseNotes, observation.releaseNotes[0], 'cached release content is identical in every state');
  }
});

test('[N38,C7] real cockpit fixture reads close API and stylesheet connections', async (t) => {
  const box = machine();
  const fixtureProject = project(box, 'wire proof');
  const channel = diagnosticsChannel.channel('undici:client:sendHeaders');
  const sent = [];
  let origin = null;
  /** Record the headers Undici is actually about to send to this fixture's view origin. */
  function recordHeaders({ request: outgoing, headers }) {
    if (origin && String(outgoing?.origin) === origin) sent.push({ path: outgoing.path, headers: String(headers) });
  }
  const httpChannel = diagnosticsChannel.channel('http.client.request.start');
  /** Observe node:http requests at the same wire boundary without depending on a client transport. */
  function recordHttpHeaders({ request: outgoing }) {
    if (!origin || 'http://' + outgoing.getHeader('host') !== origin) return;
    const headers = Object.entries(outgoing.getHeaders()).map(([name, value]) => `${name}: ${value}`).join('\r\n');
    sent.push({ path: outgoing.path, headers });
  }
  channel.subscribe(recordHeaders);
  httpChannel.subscribe(recordHttpHeaders);
  let view;
  try {
    view = await startView(box);
    origin = new URL(view.base).origin;
    await styleOf(view);
    assert.notEqual(await boardId(view, fixtureProject.repo), 'not-registered');
  } finally {
    channel.unsubscribe(recordHeaders);
    httpChannel.unsubscribe(recordHttpHeaders);
    await view?.stop();
  }
  const closes = (request) => /(?:^|\r?\n)connection:\s*close(?:\r?\n|$)/iu.test(request.headers);
  assert.ok(sent.some((request) => request.path.startsWith('/view.css') && closes(request)),
    'the real stylesheet request sends Connection: close');
  assert.ok(sent.some((request) => request.path.startsWith('/api/v1/boards') && closes(request)),
    'the real API listing request sends Connection: close');
});

test('the page uses only API v1 for state, code and every offered move [A3,N26,N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  const commit = box.git(alpha.web, 'rev-parse', 'HEAD');
  const ref = `web/greeting.html:1@${commit}`;
  box.run(alpha.web, 'shout', 'all', ref);
  const ask = JSON.parse(box.run(alpha.repo, 'shout', 'person', 'Ship the greeting?', '--decision', '--json')).id;
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const id = await boardId(view, alpha.repo);
    await page.click({ tab: 'shouts' });
    page.run("view.shoutThread = 'none'; render();");
    await page.click({ code: ref });
    assert.match(page.show('feed'), /<i>1<\/i>greeting\.html/);
    assert.equal(await page.run("act('add', {lane:'web', title:'API item', specs:'G1', brief:'Files: web/api.html'})"), true);
    assert.equal(await page.run("act('shout', {to:'web', text:'API greeting'})"), true);
    assert.equal(await page.run(`act('answer', {id:${ask}, text:'Ship it.'})`), true);
    assert.equal(await page.run("act('hold', {lane:'web', reason:'Awaiting the next decision'})"), true);
    assert.equal(await page.run("act('release', {lane:'web'})"), true);
    const moves = page.requests.filter((request) => request.method === 'POST');
    assert.deepEqual(moves.map((request) => request.body.verb), ['add', 'shout', 'answer', 'hold', 'hold']);
    assert.equal(moves[2].body.args.as, 'person');
    assert.equal(moves[2].body.item, ask);
    assert.equal(moves[4].body.args.off, true);
    // The local view also asks its own server whether it can link boards (/api/v1/view-link, #633).
    const offPublic = [...new Set(page.requests.map((request) => request.path).filter((path) => path !== '/api/v1/view-link'
      && !/^\/api\/v1\/boards(?:$|\/[^/]+\/(?:state|code|moves|events|items\/\d+|items\?q=[^&]+)(?:\?|$))/.test(path)))];
    assert.deepEqual(offPublic, [], 'every page request uses a public v1 path');
    assert.ok(page.requests.some((request) => request.path === '/api/v1/boards'));
    assert.ok(page.requests.some((request) => request.path.startsWith(`/api/v1/boards/${id}/state`)), JSON.stringify(page.requests.map((request) => request.path)));
    assert.ok(page.requests.some((request) => request.path.startsWith(`/api/v1/boards/${id}/code?`)));
    assert.ok(moves.every((request) => request.path === `/api/v1/boards/${id}/moves`));
    assert.doesNotMatch(page.html, /['"]\/api\/(?:state|act|code)(?:[?'"])/, 'the served page contains no legacy API calls');
    const state = await boardOf(view, alpha.repo);
    assert.equal(state.items.find((item) => item.title === 'API item').brief, 'Files: web/api.html');
    assert.ok(state.shouts.some((shout) => shout.shout_text === 'API greeting'));
    assert.ok(state.shouts.some((shout) => shout.shout_answers === ask && shout.shout_from === 'person'));
    assert.deepEqual(state.holds, []);
    assert.deepEqual(state.decisions, []);

    const headers = { 'x-pullboard-key': view.key };
    for (const path of ['/api/state', '/api/code', '/api/act']) {
      const response = await fetchLive(`${view.base}${path}`, { headers });
      assert.equal(response.status, 404, `${path} remains unavailable`);
      const refused = await response.json();
      assert.equal(refused.version, 1);
      assert.equal(refused.error.code, 'NO_ENDPOINT');
    }
    assert.equal((await fetchLive(`${view.base}/api/v1/boards`)).status, 401);
    assert.equal((await fetchLive(`${view.base}/api/v1/boards`, { headers: { ...headers, origin: 'http://other.invalid' } })).status, 403);
    const events = await fetchLive(`${view.base}/api/v1/boards/${id}/events`, { headers });
    assert.equal(events.status, 200, 'any app can read the same event endpoint on the view address');
    assert.ok((await events.json()).events.some((event) => event.event_kind === 'shout'));
  } finally {
    await view.stop();
  }
});

test('observation-time ages compare by their own clock [A10]', () => {
  const since = '2026-10-10T09:00:00.000Z';
  const firstAsOf = '2026-10-10T10:00:00.000Z';
  const secondAsOf = '2026-10-10T10:00:00.129Z';
  /** Build one synthetic board observation at the supplied capture time. */
  const snapshot = asOf => ({
    observedAt: asOf,
    board: { id: 'same-board', event: { event_id: 42 } },
    proofStats: {
      flow: {
        asOf,
        total: 3,
        queues: {
          open: {
            count: 1,
            oldest: { id: 7, since, ageMinutes: (Date.parse(asOf) - Date.parse(since)) / 60000 },
          },
        },
      },
      other: { asOf: 'unchanged-time', ageMinutes: 3 },
    },
  });
  const first = snapshot(firstAsOf);
  const second = snapshot(secondAsOf);
  assertObservationsEqual(first, second, '129ms-separated observations match after validating their own ages');

  const wrongClock = { ...second, observedAt: 'not a timestamp' };
  assert.throws(() => assertObservationsEqual(first, wrongClock, 'invalid read clock must be rejected'), error => error.code === 'ERR_ASSERTION' && /observedAt/u.test(error.message));
  const nestedClock = structuredClone(second);
  nestedClock.board.observedAt = secondAsOf;
  assert.throws(() => assertObservationsEqual(first, nestedClock, 'nested observedAt remains invariant'), error => error.code === 'ERR_ASSERTION');

  const wrongAge = structuredClone(second);
  wrongAge.proofStats.flow.queues.open.oldest.ageMinutes += 1;
  assert.throws(() => assertObservationsEqual(first, wrongAge, 'wrong age must be rejected'), error => error.code === 'ERR_ASSERTION' && /ageMinutes/u.test(error.message));

  const changedSince = structuredClone(second);
  changedSince.proofStats.flow.queues.open.oldest.since = '2026-10-10T08:59:59.000Z';
  changedSince.proofStats.flow.queues.open.oldest.ageMinutes = (Date.parse(secondAsOf) - Date.parse(changedSince.proofStats.flow.queues.open.oldest.since)) / 60000;
  assert.throws(() => assertObservationsEqual(first, changedSince, 'different since must be rejected'), error => error.code === 'ERR_ASSERTION');

  const changedInvariant = structuredClone(second);
  changedInvariant.proofStats.other.ageMinutes += 1;
  assert.throws(() => assertObservationsEqual(first, changedInvariant, 'unrelated ageMinutes must be retained'), error => error.code === 'ERR_ASSERTION');
});
test('view fixture retries one disconnected read with its cause and never repeats a move [N26]', async () => {
  const box = machine();
  project(box, 'transport');
  const view = await startView(box);
  const calls = new Map();
  const proxy = createServer((req, res) => {
    const count = (calls.get(req.url) ?? 0) + 1;
    calls.set(req.url, count);
    if (req.url !== '/retry' || count === 1) return req.socket.destroy();
    const upstream = request(new URL('/', view.link), { headers: { cookie: view.cookie } }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', (error) => res.destroy(error));
    upstream.end();
  });
  try {
    await new Promise((ready) => proxy.listen(0, '127.0.0.1', ready));
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const response = await fetchView(`${base}/retry`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Pullboard/);
    assert.equal(calls.get('/retry'), 2, 'exactly one retry reaches the real view');
    await assert.rejects(fetchView(`${base}/fail`), /GET .*\/fail failed after 2 attempts; attempt 1: .*caused by .*; attempt 2: .*caused by /);
    assert.equal(calls.get('/fail'), 2, 'a failed retry stops with both transport reasons');
    await assert.rejects(fetchView(`${base}/move`, { method: 'POST', body: '{}' }), /POST .*\/move failed after 1 attempt; attempt 1: .*caused by /);
    assert.equal(calls.get('/move'), 1, 'an ambiguous move is never replayed');
  } finally {
    proxy.closeAllConnections();
    await new Promise((closed) => proxy.close(closed));
    await view.stop();
  }
});

test('Chrome startup waits past the old timeout, retries once, and reports final stderr [N26,A10]', { timeout: 45_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-chrome-launch-')));
  scratch.push(dir);
  const profile = join(dir, 'slow-profile');
  mkdirSync(profile);
  const attempts = join(dir, 'slow-attempts');
  const delayed = join(dir, 'delayed-chrome');
  writeFileSync(delayed, `#!/usr/bin/env node
const { readFileSync, writeFileSync, writeSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const attempts = join(dirname(profile), 'slow-attempts');
let count = 0;
try { count = Number(readFileSync(attempts, 'utf8')); } catch {}
writeFileSync(attempts, String(++count));
if (count === 1) { writeSync(2, 'first Chrome launch failed\\n'); process.exit(17); }
setTimeout(() => {
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'DevToolsActivePort'), '9333\\n/devtools/browser/fake\\n');
  setInterval(() => {}, 1000);
}, 10_100);
`);
  chmodSync(delayed, 0o755);
  const started = Date.now();
  const chrome = await startSnapshotChrome(delayed, profile);
  try {
    assert.ok(Date.now() - started > 10_000, 'the helper waits beyond its former ten-second limit'); // budget: the stand-in publishes DevToolsActivePort after 10,100 ms.
    assert.equal(chrome.port, '9333');
    assert.equal(readFileSync(attempts, 'utf8'), '2', 'the failed first launch is retried exactly once');
  } finally {
    await stopOwnedChrome(chrome.child, chrome.stopped);
  }

  const failedAttempts = join(dir, 'failed-attempts');
  const failureProfile = join(dir, 'failure-profile');
  mkdirSync(failureProfile);
  const failing = join(dir, 'failing-chrome');
  writeFileSync(failing, `#!/usr/bin/env node
const { readFileSync, writeFileSync, writeSync } = require('node:fs');
const { dirname, join } = require('node:path');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const attempts = join(dirname(profile), 'failed-attempts');
let count = 0;
try { count = Number(readFileSync(attempts, 'utf8')); } catch {}
writeFileSync(attempts, String(++count));
writeSync(2, 'Chrome final stderr marker\\n');
process.exit(19);
`);
  chmodSync(failing, 0o755);
  let failure;
  try { await startSnapshotChrome(failing, failureProfile); }
  catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /Chrome final stderr marker/, 'a real launch failure includes Chrome stderr');
  assert.equal(readFileSync(failedAttempts, 'utf8'), '2', 'the failed launch is retried exactly once');
});

test('a Chrome wait whose condition throws while the next document loads keeps polling, and names its last error [N26,C7]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the browser wait proof.');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (request.url === '/late') {
      // The head arrives now and the body 1.5 s later, so the next document parses without #late for a while.
      response.write('<!doctype html><html><head><title>late</title></head>');
      setTimeout(() => response.end('<body><p id="late">the late body arrived</p></body></html>'), 1500);
      return;
    }
    if (request.url === '/fault') {
      response.end('<!doctype html><script>window.__faultRan = true; throw new Error("page fault fixture");</script>');
      return;
    }
    response.end('<!doctype html><p id="first">first page</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-wait-chrome-'));
  let chrome;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    chrome = await openSnapshotChrome(executable, `${origin}/first`, profile);
    await chrome.waitFor("document.querySelector('#first')?.textContent === 'first page'");
    await chrome.send('Page.navigate', { url: `${origin}/late` });
    await chrome.waitFor("document.querySelector('#late').textContent.includes('the late body arrived')");
    await assert.rejects(chrome.waitFor("document.querySelector('#never').textContent === 'never'", 1000), // budget: 1,000 ms is only a ceiling for an impossible browser condition.
      /^Error: Browser condition did not arrive: .*#never.*; it last threw: TypeError: Cannot read properties of null/u);
    assert.deepEqual(chrome.exceptions, [], 'a condition that throws is not a page exception');
    await chrome.send('Page.navigate', { url: `${origin}/fault` });
    await chrome.waitFor('window.__faultRan === true');
    assert.equal(chrome.exceptions.length, 1, 'an exception the page throws by itself is still collected');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});

test('owned Chrome cleanup waits out a slow exit and still fails a real hang [C7,N26]', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-owned-chrome-cleanup-')));
  scratch.push(dir);
  const launched = [];
  const independent = [];
  /** Launch a private stand-in and retain its close promise just as the cockpit launcher does. */
  function launch(code, args = []) {
    const child = spawn(process.execPath, ['-e', code, ...args], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    const stopped = new Promise(resolve => child.once('close', resolve));
    const result = { child, stopped };
    launched.push(result);
    return result;
  }
  /** Wait for the child to install its signal handlers before testing cleanup. */
  async function ready(path) {
    const deadline = Date.now() + 10_000;
    while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(path), 'the owned stand-in installed its handlers');
  }
  t.after(async () => {
    for (const pid of independent) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (const { child, stopped } of launched) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      child.stderr.destroy();
      await stopped;
    }
  });

  const pipeReady = join(dir, 'pipe-ready');
  const holder = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
  const pipe = launch(`const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => process.exit(0));
    const helper = spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
    helper.unref(); setInterval(() => {}, 1000);`, [holder, pipeReady]);
  await ready(pipeReady);
  const holderPid = Number(readFileSync(pipeReady, 'utf8'));
  independent.push(holderPid);
  const nativeKill = process.kill.bind(process);
  let permissionProbe = false;
  const kill = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -pipe.child.pid && signal === 0 && !permissionProbe) {
      permissionProbe = true;
      throw Object.assign(new Error('probe temporarily refused'), { code: 'EPERM' });
    }
    return nativeKill(pid, signal);
  });
  try { await stopOwnedChrome(pipe.child, pipe.stopped); }
  finally { kill.mock.restore(); }
  assert.equal(permissionProbe, true, 'a refused group probe cannot prove the group has exited');
  assert.doesNotThrow(() => process.kill(holderPid, 0), 'cleanup releases stderr without killing an independent holder');
  assert.ok(pipe.child.exitCode !== null || pipe.child.signalCode !== null, 'the owned leader exited');

  const slowReady = join(dir, 'slow-ready');
  const slowFinished = join(dir, 'slow-finished');
  const slowHelper = `const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(process.argv[2], 'finished'); process.exit(0); }, 150));
    fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);`;
  const slow = launch(`const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => process.exit(0));
    spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`, [slowHelper, slowReady, slowFinished]);
  await ready(slowReady);
  await stopOwnedChrome(slow.child, slow.stopped);
  assert.equal(readFileSync(slowFinished, 'utf8'), 'finished', 'cleanup waited for the helper after the leader and its pipe closed');
  assert.throws(() => process.kill(-slow.child.pid, 0), { code: 'ESRCH' }, 'no owned helper survives successful cleanup');

  const hangReady = join(dir, 'hang-ready');
  const hung = launch(`const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);`, [hangReady]);
  await ready(hangReady);
  const signals = [];
  await assert.rejects(stopOwnedChrome(hung.child, hung.stopped, {
    timeoutMs: 100, // budget: the stand-in intentionally survives both signals; bound only this forced failure.
    signal: (pid, name) => { signals.push({ pid, name }); },
  }), error => {
    assert.match(error.message, /did not exit after SIGKILL; waited \d+ms; live pids:/u);
    assert.ok(error.message.split('live pids: ')[1].split(', ').includes(String(hung.child.pid)), 'the hang names its surviving pid');
    assert.doesNotThrow(() => process.kill(hung.child.pid, 0), 'the reported hang is an actual surviving stand-in');
    return true;
  });
  assert.deepEqual(signals, [
    { pid: -hung.child.pid, name: 'SIGTERM' },
    { pid: -hung.child.pid, name: 'SIGKILL' },
  ], 'cleanup tries both signals against only its owned group');
});


test('a timed-out wait names what moved [N26,C7]', { timeout: 60_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the wait capture control');
  const responses = new Set();
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // Keep parsing open so the loading observation is from a real unfinished document.
    response.write('<!doctype html><html><body class="loading switching" style="height:4000px">'
      + '<button id="capture-target" style="position:fixed;top:100px;left:20px;width:100px;height:40px">private stand-in text</button>'
      + '<div id="capture-noise" style="width:20px;height:10px"></div>');
    responses.add(response);
    response.once('close', () => responses.delete(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-wait-capture-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${server.address().port}`, profile);
    await chrome.waitFor("!!document.querySelector('#capture-target')");
    const controls = [
      ['target', "node.style.width = (100 + step % 2) + 'px'"],
      ['replacement', "const next = node.cloneNode(true); node.replaceWith(next); node = next"],
      ['text', "node.textContent = String(step % 2)"],
      ['scroll', "scrollTo(0, 30 * (step % 2))"],
    ];
    for (const [kind, mutate] of controls) {
      await chrome.stable('window.__captureStep = 0');
      const find = `(() => {
        const step = ++window.__captureStep;
        let node = document.querySelector('#capture-target');
        document.querySelector('#capture-noise').style.width = (20 + step % 2) + 'px';
        ${mutate};
        return node;
      })()`;
      let failure;
      try { await waitForStableBoxes(chrome, find, 1000); } // budget: declared negative-control deadline for a deliberately moving stand-in page.
      catch (error) { failure = error; }
      assert.match(failure?.message ?? '', /shared wait: target missing, zero-sized or moving:/);
      assert.ok(failure.message.includes('; wait capture '), 'timeout includes bounded wait capture');
      const capture = JSON.parse(failure.message.split('; wait capture ')[1].split('\n')[0]);
      assert.ok(capture.changes[kind] > 0, `${kind} is measured: ${JSON.stringify(capture)}`);
      assert.ok(capture.samples.length > 0 && capture.samples.length <= 4, 'only the bounded tail is retained');
      assert.ok(capture.samples.some(sample => sample.targets?.length), 'the actual target boxes are retained');
      assert.ok(capture.frames > 0 && capture.maxFrameGapMs >= 0, 'frame count and gap are measured');
      assert.ok(capture.samples.every(sample => sample.sampleMs >= 0), 'each layout sample records its duration');
      assert.equal(capture.page.readyState, 'loading');
      assert.equal(capture.page.loading, true);
      assert.equal(capture.page.switching, true);
      assert.ok(JSON.stringify(capture).length < 7000, 'the diagnostic is bounded independently of the page contents');
      assert.ok(!JSON.stringify(capture).includes('private stand-in text'), 'text changes do not copy board contents');
      for (const absent of ['target', 'replacement', 'text', 'scroll'].filter(signal => signal !== kind)) {
        assert.equal(capture.changes[absent], 0, `${kind} does not falsely report ${absent}`);
      }
    }
    await assert.rejects(chrome.waitFor('false', 1000), error => { // budget: declared negative-control deadline for a condition that never becomes true.
      const capture = JSON.parse(error.message.split('; readiness capture ')[1]);
      assert.ok(capture.polls > 0 && capture.falseResults === capture.polls);
      assert.ok(capture.lastPollMs >= 0 && capture.maxPollMs >= capture.lastPollMs);
      assert.equal(capture.lastStable.page.readyState, 'loading');
      assert.equal(capture.lastStable.page.switching, true);
      assert.ok(capture.lastStable.samples.length <= 4);
      return true;
    });
    for (const response of responses) response.end('</body></html>');
    await chrome.waitFor("document.readyState === 'complete'");
    assert.deepEqual(chrome.exceptions, [], 'capture does not create a page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});
