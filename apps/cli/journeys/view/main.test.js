import { viewApiPorts } from '../../../view/index.js';
/**
 * The spec view (S7): one offline page with the spec, open questions, sign-offs and practice, where
 * no text from the files can inject markup.
 */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  after,
  test,
} from 'node:test';
import { main } from '../../tests/fixtures/native.js';
import { createLocalApiHandler } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import {
  forgetProject,
  listApiProjects,
} from '../../../../packages/seats/index.js';
import {
  runningView,
  rememberView,
  forgetView,
} from '../../../view/index.js';
import { fetchFresh } from '../../tests/fixtures/http.js';
import { parseSpec } from '../../../../packages/spec/index.js';
import { standardDoctrine } from '../../../../packages/doctrine/index.js';
import {
  esc,
  renderSpecView,
} from '../../../view/index.js';
import { assertPublicExportSupported } from '../../index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const SPEC = `# Bakery spec

Pre-orders for four shops.

## O · Orders
- O1 [approved, must] Orders lock at 2pm the day before pickup. | gate: lock test
- O2 [approved, must] A confirmation text names the shop. | gate: text test
- O3 [pending] Can a customer cancel after the lock?
- O4 [draft, aim] Show <script>alert(1)</script> nowhere. | gate: xss test
`;

const PRIVATE_DIRS = [];
const API_SPEC = '# View fixture\n\n## G · Goals\n- G1 [approved, must] Keep the local view scoped. | gate: true\n';

/** Create an isolated, disposable project registry and Git environment for view/API contract tests. */
function privateBox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-view-scope-')));
  PRIVATE_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dirname, '../../pullboard.js'))} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'View fixture', GIT_AUTHOR_EMAIL: 'view@example.invalid',
    GIT_COMMITTER_NAME: 'View fixture', GIT_COMMITTER_EMAIL: 'view@example.invalid',
    PULLBOARD_HOME: join(dir, 'home'), HOME: join(dir, 'private-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PULLBOARD_MODEL: 'fixture-model',
  };
  for (const key of ['PULLBOARD_RELAY_TOKEN', 'PULLBOARD_VIEW_FOREGROUND', 'AI_AGENT']) delete env[key];
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../pullboard.js'), ...args], { cwd, env, encoding: 'utf8' });
  return { dir, env, git, run };
}

/** Initialize one private board with a short name and a lane suitable for fixture items. */
function privateProject(box, name) {
  const repo = join(box.dir, name);
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const init = box.run(repo, 'init', '--json');
  assert.equal(init.status, 0, init.failure ?? init.stderr);
  const configPath = join(repo, 'pullboard.json');
  // View fixtures file "true" checks to show items, so they keep a board with no hold setting.
  const { checks: _hold, ...config } = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, name, gate: 'true', spec: 'SPEC.md', practice: 'DOCTRINE.md',
    lanes: { app: { owns: ['app/'], specs: ['G1'] }, review: { owns: [] } }, shared: [] }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), API_SPEC);
  writeFileSync(join(repo, 'DOCTRINE.md'), '');
  mkdirSync(join(repo, 'app'));
  writeFileSync(join(repo, 'app', 'fixture.js'), '// private view fixture\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up view fixture');
  return { repo, name };
}

/** Install and restore only the process environment keys used by this private fixture. */
function usePrivateEnvironment(env) {
  const previous = new Map();
  for (const key of ['PULLBOARD_HOME', 'HOME', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_MODEL', 'PULLBOARD_VIEW_FOREGROUND', 'AI_AGENT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    previous.set(key, process.env[key]);
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Start one local handler on loopback and close it with its owning test. */
async function serveHandler(t, handler, secret) {
  const server = createServer(handler);
  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ready);
  });
  const port = server.address().port;
  t.after(async () => {
    handler.close?.();
    const closed = new Promise((done) => server.close(done));
    server.closeAllConnections();
    await closed;
  });
  return { origin: `http://127.0.0.1:${port}`, secret, port };
}

/** Make one authenticated local API request without ever placing the key in assertion text. */
function viewApiFetch(api, path, options = {}) {
  return fetchFresh(new URL(path, api.origin), { ...options,
    headers: { 'x-pullboard-key': api.secret, ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(3_000),
  });
}

/** Read a structured API refusal while asserting only its public status and code. */
async function viewApiError(response, status, code) {
  assert.equal(response.status, status);
  const document = await response.json();
  assert.equal(document.error?.code, code);
  return document.error;
}

/** Read the next structured SSE data frame; the timeout is only a hang ceiling for a triggered event. */
async function nextViewStreamEvent(reader, predicate) {
  const decoder = new TextDecoder();
  let buffer = '';
  const read = async () => {
    while (true) {
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const text = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = [...text.matchAll(/^data: (.+)$/gmu)].map((match) => match[1]).join('\n');
        if (data) {
          const frame = JSON.parse(data);
          if (predicate(frame)) return frame;
        }
        boundary = buffer.indexOf('\n\n');
      }
      const { done, value } = await reader.read();
      assert.equal(done, false, 'the selected-board stream stays open');
      buffer += decoder.decode(value, { stream: true });
    }
  };
  let timer;
  try {
    return await Promise.race([read(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the stream did not deliver the triggered local event')), 5_000); // budget: 5s hang-only ceiling for a triggered event, not a timing assertion.
    })]);
  } finally { clearTimeout(timer); }
}

after(() => { for (const dir of PRIVATE_DIRS) rmSync(dir, { recursive: true, force: true }); });

test('public export refuses an exporter without declared filter support [N26]', async () => {
  let called = false;
  /** Model the pre-public exporter, which ignores any extra option. */
  async function legacyExporter() { called = true; return { path: '/unused' }; }
  assert.throws(() => assertPublicExportSupported(legacyExporter), (error) => {
    assert.equal(error.code, 'PUBLIC_EXPORT_UNAVAILABLE');
    return true;
  });
  assert.equal(called, false);
  const supported = Object.assign(async () => ({ path: '/unused' }), { supportsPublicExport: true });
  assert.doesNotThrow(() => assertPublicExportSupported(supported));
});

/**
 * The page for the sample spec, with O1 signed on its current text and O2 signed on older text.
 */
function page(practice = standardDoctrine()) {
  const spec = { ...parseSpec(SPEC), exists: true };
  const signoffs = [
    { id: 'O1', by: 'CO', on: '2026-10-05', text: 'Orders lock at 2pm the day before pickup.' },
    { id: 'O2', by: 'CO', on: '2026-10-04', text: 'A text names the shop.' },
  ];
  return renderSpecView({
    title: spec.title,
    spec,
    practice,
    signoffs,
    generatedAt: '2026-10-05 12:00',
    files: { spec: 'SPEC.md', practice: 'PRACTICE.md' },
  });
}

test('one self-contained page with every tab and inherited doctrine row [S7,D1,D3]', () => {
  const html = page();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/src="http|href="http/.test(html), 'nothing loads from the network');
  for (const label of ['Spec', 'Open questions (1)', 'Sign-off', 'Doctrine']) assert.ok(html.includes(label));
  for (const id of ['O1', 'O2', 'O3', 'O4', 'PB1', 'PB12']) assert.ok(html.includes(`>${id}<`), `${id} is on the page`);
});

test('legacy repo practice rows still render without being replaced [S7,D4]', () => {
  const practice = { ...parseSpec('# Legacy practice\n\n## Writing\n- W1 [fact] A local writing rule.\n\n## Git\n- G4 [fact] A local Git rule.\n'), exists: true };
  const html = page(practice);
  for (const id of ['W1', 'G4']) assert.ok(html.includes(`>${id}<`), `${id} remains on the page`);
});

test('sign-offs show as signed, stale or not signed [S5, S7]', () => {
  const html = page();
  assert.ok(html.includes('signed CO 2026-10-05'));
  assert.ok(html.includes('stale: text changed since sign-off'));
  assert.ok(html.includes('<b>1/2</b><span>approved must-rows signed</span>'));
});

test('row text is escaped, so a row cannot inject markup [S7]', () => {
  const html = page();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(esc(`a<b>"c"&'d'`), 'a&lt;b&gt;&quot;c&quot;&amp;&#39;d&#39;');
});

test("pullboard view --project scopes the view to this repository's project and refuses before registering outsiders [N26]", async (t) => {
  const box = privateBox();
  const project = privateProject(box, 'view-local');
  const outside = privateProject(box, 'view-outsider');
  const restore = usePrivateEnvironment({ ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' });
  t.after(restore);

  const worktree = box.run(project.repo, 'worktree', 'app', '--model', 'fixture-agent', '--json');
  assert.equal(worktree.status, 0, worktree.failure ?? worktree.stderr);
  const linkedPath = JSON.parse(worktree.stdout).path;
  assert.equal(forgetProject(outside.repo), true, 'the outsider is deliberately absent from the project registry');

  async function runScoped(cwd) {
    let captured;
    const pending = main(['view', '--project', '--no-open', '--json'], {
      cwd,
      stdin: process.stdin,
      stdout: { isTTY: true, write() {} },
      stderr: { write() {} },
      serveView: async (options) => {
        captured = options;
        return { url: 'http://127.0.0.1:49991/?k=private-fixture-key', port: 49991, close: async () => {} };
      },
    });
    const deadline = Date.now() + 5_000;
    while (!captured && Date.now() < deadline) await new Promise((done) => setImmediate(done));
    assert.ok(captured, 'the CLI reached the injected private view adapter');
    await new Promise((done) => setImmediate(done));
    process.emit('SIGINT');
    assert.equal(await pending, 0);
    return captured;
  }

  const linked = await runScoped(linkedPath);
  assert.equal(linked.projectRoot, project.repo, 'a linked worktree resolves to its registered main project');
  assert.equal(linked.port, 0, 'a scoped default asks for an isolated free port');

  let adapterCalled = false;
  let refusalOutput = '';
  const refused = await main(['view', '--project', '--no-open', '--json'], {
    cwd: outside.repo, stdin: process.stdin,
    stdout: { isTTY: true, write: (part) => { refusalOutput += part; } },
    stderr: { write() {} },
    serveView: async () => { adapterCalled = true; throw new Error('must refuse before serving'); },
  });
  assert.equal(refused, 1);
  assert.equal(adapterCalled, false, 'an unregistered repo is refused before a listener starts');
  const refusal = JSON.parse(refusalOutput).error;
  assert.equal(refusal.code, 'PROJECT_NOT_REGISTERED');
  assert.match(refusal.message, /registered project repository/u);
  assert.ok(!JSON.stringify(listApiProjects()).includes(outside.repo),
    'the scoped command does not auto-register an unregistered repo');

  let help = '';
  assert.equal(await main(['view', '--help'], {
    cwd: project.repo, stdin: process.stdin,
    stdout: { isTTY: true, write: (part) => { help += part; } },
    stderr: { write() {} },
  }), 0);
  assert.match(help, /--project/u, 'the view-specific help names the project flag');
});

test('scoped API answers and its cache and stream never resolve a foreign roadmap [N26,A2]', async (t) => {
  const box = privateBox();
  const local = privateProject(box, 'view-local');
  const foreign = privateProject(box, 'view-foreign');
  const restore = usePrivateEnvironment(box.env);
  t.after(restore);

  const add = (project, title) => {
    const result = fixtureAdd(box.run, project.repo, 'app', title, '--criterion', 'fixture item', '--specs', 'G1', '--route', 'strong',
      '--brief', 'Files: app/fixture.js\nChange: create fixture work\nTest: inspect the local API', '--check', 'true', '--json');
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    return JSON.parse(result.stdout).item;
  };
  const localItem = add(local, 'Local scoped item');
  const foreignTitle = `FOREIGN-ROADMAP-${randomUUID()}`;
  const foreignItem = add(foreign, foreignTitle);
  const milestone = box.run(local.repo, 'milestone', 'add', 'External obligation', '--items', `${foreign.name}#${foreignItem.item_id}`, '--json');
  assert.equal(milestone.status, 0, milestone.failure ?? milestone.stderr);
  const localAgent = box.run(local.repo, 'worktree', 'app', '--model', 'fixture-agent', '--json');
  assert.equal(localAgent.status, 0, localAgent.failure ?? localAgent.stderr);
  const localLinkedPath = JSON.parse(localAgent.stdout).path;

  let port = 0;
  const scopedSecret = randomUUID();
  const options = { secret: scopedSecret, getPort: () => port, runCommand: main };
  const scopedHandler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, ...options, scope: { projectRoot: localLinkedPath } });
  const scoped = await serveHandler(t, scopedHandler, options.secret);
  port = scoped.port;
  const plainSecret = randomUUID();
  let plainPort = 0;
  const plainHandler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, ...options, secret: plainSecret, getPort: () => plainPort });
  const plain = await serveHandler(t, plainHandler, plainSecret);
  plainPort = plain.port;

  const listingResponse = await viewApiFetch(scoped, '/api/v1/boards');
  assert.equal(listingResponse.status, 200);
  const listing = await listingResponse.json();
  assert.equal(listing.boards.length, 1, 'the scoped board list contains only one registered repository');
  const localBoard = listing.boards[0];

  const plainListing = await (await viewApiFetch(plain, '/api/v1/boards')).json();
  assert.equal(plainListing.boards.length, 2, 'the unscoped API keeps its every-project default');
  const foreignBoard = plainListing.boards.find((entry) => entry.root === foreign.repo);
  assert.ok(foreignBoard?.id);
  await viewApiError(await viewApiFetch(scoped, `/api/v1/boards/${foreignBoard.id}/state`), 404, 'NO_BOARD');
  await viewApiError(await viewApiFetch(scoped, `/api/v1/boards/${foreignBoard.id}/items/${foreignItem.item_id}`), 404, 'NO_BOARD');

  const stateResponse = await viewApiFetch(scoped, `/api/v1/boards/${localBoard.id}/state`);
  assert.equal(stateResponse.status, 200);
  const stateDocument = await stateResponse.json();
  const external = stateDocument.state.milestones[0].items[0];
  assert.deepEqual(external, { id: 'external-1', title: 'External item', status: 'unavailable', state: 'unavailable' });
  assert.ok(localItem.item_id > 0);
  const localRoadmap = JSON.stringify(stateDocument.state.milestones);
  assert.ok(!localRoadmap.includes(foreign.name));
  assert.ok(!localRoadmap.includes(`${foreign.name}#${foreignItem.item_id}`));
  assert.ok(!localRoadmap.includes(foreignTitle));

  const plainState = await (await viewApiFetch(plain, `/api/v1/boards/${localBoard.id}/state`)).json();
  assert.equal(plainState.state.milestones[0].items[0].title, foreignTitle,
    'plain all-project API still resolves the registered external item');
  assert.equal(plainState.state.milestones[0].items[0].status, 'open');

  const summaryResponse = await viewApiFetch(scoped, `/api/v1/boards/${localBoard.id}/state?detail=summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.deepEqual(summary.state.milestones[0].items[0], external,
    'summary state uses the same hidden unavailable obligation');
  const deltaResponse = await viewApiFetch(scoped,
    `/api/v1/boards/${localBoard.id}/state?detail=summary&since=${summary.state.sequence}&eventLogVersion=${summary.eventLogVersion}`);
  assert.equal(deltaResponse.status, 200);
  assert.ok(!JSON.stringify(await deltaResponse.json()).includes(foreignTitle), 'the cached delta carries no foreign roadmap data');
  const search = await (await viewApiFetch(scoped,
    `/api/v1/boards/${localBoard.id}/items?q=${encodeURIComponent(foreignTitle)}`)).json();
  assert.deepEqual(search.ids, [], 'scoped search only sees local items');

  const localEvents = await viewApiFetch(scoped, `/api/v1/boards/${localBoard.id}/events?after=${stateDocument.state.sequence}`);
  assert.equal(localEvents.status, 200, 'the selected board event route remains available');
  await localEvents.body?.cancel();
  await viewApiError(await viewApiFetch(scoped, `/api/v1/events?boards=${foreignBoard.id}`, {
    headers: { accept: 'text/event-stream' },
  }), 404, 'NO_BOARD');
  await viewApiError(await viewApiFetch(scoped, `/api/v1/events?boards=${localBoard.id},${foreignBoard.id}`, {
    headers: { accept: 'text/event-stream' },
  }), 404, 'NO_BOARD');

  const controller = new AbortController();
  const streamResponse = await viewApiFetch(scoped,
    `/api/v1/boards/${localBoard.id}/events?after=${stateDocument.state.sequence}`, {
      headers: { accept: 'text/event-stream' }, signal: controller.signal,
    });
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body.getReader();
  const initial = await reader.read();
  assert.ok(new TextDecoder().decode(initial.value).includes(': API v1'));

  const agent = box.run(foreign.repo, 'worktree', 'app', '--model', 'fixture-agent', '--json');
  assert.equal(agent.status, 0, agent.failure ?? agent.stderr);
  const agentPath = JSON.parse(agent.stdout).path;
  const claimed = box.run(agentPath, 'claim', String(foreignItem.item_id), '--json');
  assert.equal(claimed.status, 0, claimed.failure ?? claimed.stderr);

  const scopedAgain = await (await viewApiFetch(scoped, `/api/v1/boards/${localBoard.id}/state`)).json();
  assert.deepEqual(scopedAgain.state.milestones[0].items[0], external,
    'a foreign-only status change neither invalidates nor enriches the scoped cache');
  const plainAgain = await (await viewApiFetch(plain, `/api/v1/boards/${localBoard.id}/state`)).json();
  assert.equal(plainAgain.state.milestones[0].items[0].status, 'claimed',
    'the unscoped resolver still follows the registered foreign board');

  const localStreamTitle = `LOCAL-STREAM-${randomUUID()}`;
  const localStreamItem = add(local, localStreamTitle);
  const localFrame = await nextViewStreamEvent(reader, frame => frame.event?.event_kind === 'add'
    && frame.event.item_id === localStreamItem.item_id);
  assert.ok(!JSON.stringify(localFrame).includes(foreignTitle), 'stream event data contains no foreign item title');
  assert.ok(!JSON.stringify(localFrame).includes(`${foreign.name}#${foreignItem.item_id}`),
    'stream event data contains no foreign repo-qualified reference');
  await reader.cancel();
  controller.abort();
});

test('view listener reuse requires the exact saved scope; old records are unscoped [N26]', async (t) => {
  const box = privateBox();
  const restore = usePrivateEnvironment(box.env);
  t.after(restore);
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ boards: [], warnings: [] }));
  });
  await new Promise((ready, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ready); });
  const port = server.address().port;
  t.after(async () => { const done = new Promise((resolveClosed) => server.close(resolveClosed)); server.closeAllConnections(); await done; });
  const commonDir = join(box.dir, 'registered-common-dir');
  const scopedRecord = { port, secret: 'fixture-secret', pid: process.pid, boundAt: new Date(0).toISOString(), scopeCommonDir: commonDir };
  rememberView(scopedRecord);
  assert.equal(Boolean(await runningView(port, commonDir)), true, 'the same project can reuse its listener');
  assert.equal(await runningView(port, null), null, 'the plain all-project view cannot reuse a scoped listener');
  assert.equal(await runningView(port, `${commonDir}-other`), null, 'another scoped project cannot reuse this listener');

  forgetView(port);
  rememberView({ port, secret: 'fixture-secret', pid: process.pid, boundAt: new Date(0).toISOString() });
  assert.equal(Boolean(await runningView(port, null)), true, 'a pre-scope session without scope metadata remains unscoped');
  assert.equal(await runningView(port, commonDir), null, 'a scoped view cannot reuse a legacy unscoped listener');
  forgetView(port);
});
