/** @pullboard-test-gui */
/** Cockpit relay checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { press, stableChrome } from './stable.js';
import { createJourneyDeadline, drainJourneyTasks } from './journey-deadline.js';
import { cockpitPage } from '../../src/cockpit.js';
import { createRelayBrowserHandler } from '../../relay/browser-page.js';
import { relayClientFixture } from '../relay-client-fixture.js';
import { runFixtureChildAsync } from '../fixture-child.js';
import { findChromeExecutable, relayWorkBudgetMs, startChrome } from '../relay-browser-fixture.js';
import { BIN, scratch, SPEC, machine, project, fetchLive, startView, target, chromeExecutable, browserPause, startSnapshotChrome, openSnapshotChrome, stopOwnedChrome, closeSnapshotChrome, pickProject, proofShot } from './fixture.js';
import { STAR_SHOWN, STAR_TEXT, starLineFixture, starRepository, starSteps } from './star-line.js';

test('a paired relay reference explains that committed source is available only in the local project view [B33]', {
  // Its relay work is the fixture's setup moves, the browser's pairing and the reference's request: three budgets,
  // derived from the work as main's relay tests are, so it holds under load.
  timeout: relayWorkBudgetMs() * 3,
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const sentinel = 'RELAY_SOURCE_MUST_STAY_LOCAL_251';
  const oldItem = String(box.before.tables.item[0].item_id);
  assert.equal((await box.cli('withdraw', oldItem, 'replace the fixture item with a source lane')).code, 0,
    'the private setup item is withdrawn before coordinator setup is committed');
  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.app = { owns: ['src/'], specs: ['G'] };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const fixtureBin = box.env.PATH.split(delimiter)[0];
  const wrapper = join(fixtureBin, 'pullboard');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: box.root, env: box.env }).status, 0,
    'the coordinator stages the private repository setup');
  const setupCommit = spawnSync('git', ['commit', '-q', '-m', 'chore: set up paired relay source fixture'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(setupCommit.status, 0, `the fixture config is committed through normal hooks: ${setupCommit.stderr.trim()}`);
  const sourceWorktree = join(box.root, '..', 'source-worktree');
  const worktree = spawnSync('git', ['worktree', 'add', '-b', 'app/relay-source', sourceWorktree], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(worktree.status, 0, `the fixture creates a lane-owned source checkout: ${worktree.stderr.trim()}`);
  const sourceCli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' });
  const joined = sourceCli('join', 'app');
  assert.equal(joined.status, 0, `the source checkout joins its lane: ${joined.stderr.trim()}`);
  const itemTitle = 'private cleanup fixture item 251';
  const addedItem = await box.cli('add', 'app', itemTitle);
  assert.equal(addedItem.code, 0, `the coordinator adds a fixture item after the setup commit: ${JSON.stringify(addedItem.document.error ?? addedItem.document)}`);
  const latest = await box.cli('export');
  assert.equal(latest.code, 0);
  const fixtureItem = String(latest.document.tables.item.find(row => row.item_title === itemTitle).item_id);
  const claimed = sourceCli('claim', fixtureItem);
  assert.equal(claimed.status, 0, `the source checkout claims the fixture item: ${claimed.stderr.trim()}`);
  const sourceFile = join(sourceWorktree, 'src', 'local-only.js');
  mkdirSync(resolve(sourceFile, '..'), { recursive: true });
  writeFileSync(sourceFile, `export const localOnly = '${sentinel}';\n`);
  assert.equal(spawnSync('git', ['add', '--', relative(sourceWorktree, sourceFile)], { cwd: sourceWorktree, env: box.env }).status, 0);
  const subject = 'chore(app): add local-only source';
  const committed = spawnSync('git', ['commit', '-q', '-m', subject], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, `the reference names a real committed source file: ${committed.stderr.trim()}`);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceWorktree, env: box.env, encoding: 'utf8' }).trim();
  const sourceRef = relative(sourceWorktree, sourceFile).split(sep).join('/');
  const ref = `${sourceRef}:1@${sha}`;
  assert.equal((await box.cli('shout', 'all', `source: ${ref}`)).code, 0);
  await box.link();
  assert.equal((await box.cli('status')).code, 0, 'the linked board publishes its reference');

  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  // Since person power stays on the paired phone, the browser reads the board with the phone's session, not the link's.
  assert.equal((await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true, 'the private browser receives the paired phone’s authenticated session');
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
  await chrome.waitFor(`document.querySelector('#chain')?.textContent.includes(${JSON.stringify(itemTitle)})`);
  await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
  await chrome.waitFor(`document.querySelector('#feed button[data-code^="${sourceRef}:1@"]')`);
  const beforeOpen = box.calls.length;
  for (const width of [375, 1280]) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor(`innerWidth === ${width}`);
    const button = `document.querySelector('#feed button[data-code^="${sourceRef}:1@"]')`;
    if (!await chrome.stable(`${button}.getAttribute('aria-expanded') === 'true'`)) await chrome.click(`${button}`);
    await chrome.waitFor(`${button}.nextElementSibling?.querySelector('.code')?.textContent.includes('local project view')`);
    assert.equal(await chrome.stable(`document.body.textContent.includes(${JSON.stringify(sentinel)})`), false,
      'the paired relay browser never receives committed source text');
    assert.equal(await chrome.stable(`JSON.stringify(data).includes(${JSON.stringify(sentinel)})`), false,
      'the decoded relay presentation contains only the reference, not source bytes');
    assert.equal(await chrome.stable(`${button}.nextElementSibling.querySelector('.code').textContent`),
      'Source code is unavailable in a relay view; open this reference in the local project view.');
    assert.equal(await chrome.stable(`document.querySelector('#feed button[data-code-all]') === null`), true,
      'a relay reference exposes no control that could request more source');
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
      `${width}px relay reference stays within the viewport`);
  }
  assert.equal(box.calls.slice(beforeOpen).some(call => /\/code(?:\?|$)/.test(call.path)), false,
    'opening the reference never asks the relay for source');
});


test('the view opens the board the relay just approved [H17,E16]', { timeout: 90_000 }, async t => { // budget: hang ceiling for two private real boards and one owned Chrome, not a throughput assertion.
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the approved-board proof.');
  const box = machine();
  const first = project(box, 'current-board');
  const second = project(box, 'approved-board');
  box.run(first.repo, 'add', 'web', 'Current board item');
  box.run(second.repo, 'add', 'web', 'Newly approved board item');
  const live = await startView(box);
  const listed = await fetchLive(live.base + '/api/v1/boards', { headers: { 'x-pullboard-key': live.key } });
  const boards = (await listed.json()).boards;
  const firstId = boards.find(board => board.name === 'current-board').id;
  const secondId = boards.find(board => board.name === 'approved-board').id;
  let pageVisits = 0;
  const methods = [];
  const moduleSource = `/** Report a link approval while keeping every board read backed by the private real view. */
export async function createTransport({ onUpdate, onOpenBoard }) {
  let approved = false;
  window.__transportUpdate = onUpdate;
  window.__approvalCalls = 0;
  /** Announce one newly readable board through the explicit callback, with the previous update-only control. */
  window.__approveBoard = async () => {
    approved = true;
    window.__approvalCalls += 1;
    if (onOpenBoard) await onOpenBoard(${JSON.stringify(secondId)});
    else await onUpdate();
  };
  /** Read real board documents and expose the second board only after its link approval. */
  return { async request(path, body) {
    if (body != null) throw new Error('The stand-in permits board reads only.');
    const response = await fetch('/fixture' + path);
    const document = await response.json();
    if (!response.ok) throw new Error('Private board read failed: ' + response.status);
    if (path === '/api/v1/boards' && !approved) document.boards = document.boards.filter(board => board.id === ${JSON.stringify(firstId)});
    return document;
  } };
}`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      pageVisits += 1;
      return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
    }
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(moduleSource);
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(new URL('../../src/view.css', import.meta.url)));
    if (!url.pathname.startsWith('/fixture/')) return response.writeHead(404).end();
    methods.push(request.method);
    if (request.method !== 'GET') return response.writeHead(405).end();
    fetchLive(live.base + url.pathname.slice('/fixture'.length) + url.search, { headers: { 'x-pullboard-key': live.key } })
      .then(async reply => response.writeHead(reply.status, { 'content-type': 'application/json' }).end(await reply.text()))
      .catch(() => response.writeHead(502).end());
  });
  let chrome;
  try {
    await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${server.address().port}/`, join(box.dir, 'approved-board-chrome'));
    await chrome.waitFor(`view.root === ${JSON.stringify(firstId)} && data?.project?.items.some(item => item.title === 'Current board item')`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await chrome.click('document.querySelector(\'[data-tab="shouts"]\')');
    await chrome.waitFor('view.tab === "shouts" && document.querySelector(\'[data-pane="items"]\').hidden');
    const documentOrigin = await chrome.stable('performance.timeOrigin');
    await chrome.stable('window.__transportUpdate()');
    assert.equal(await chrome.stable('view.root'), firstId, 'a transport update without an approved-board callback leaves the current board selected');
    assert.equal(await chrome.stable('view.tab'), 'shouts', 'an ordinary transport update preserves the selected tab');
    await chrome.stable('window.__approveBoard()');
    assert.equal(await chrome.stable(`data.projects.some(board => board.id === ${JSON.stringify(secondId)} && board.ok)`), true, 'the approved board is genuinely available before the selection assertion');
    assert.equal(await chrome.stable('view.root'), secondId, 'the explicit approval opens its board rather than merely refreshing the old one');
    assert.equal(await chrome.stable("document.querySelector('#proj-name').textContent"), 'approved-board');
    assert.equal(await chrome.stable("document.querySelector('#chain').textContent.includes('Newly approved board item')"), true);
    for (const width of [390, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
      assert.equal(await chrome.stable(`(() => {
        const pane = document.querySelector('[data-pane="items"]');
        const row = document.querySelector('#chain [data-item]');
        const rect = row?.getBoundingClientRect();
        return !pane.hidden && row.getClientRects().length > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
      })()`), true, `${width}px approval opens visible items after reading Shouts`);
    }
    assert.equal(await chrome.stable('performance.timeOrigin'), documentOrigin, 'the original document remains open');
    assert.equal(pageVisits, 1, 'approval does not reload the page or start pairing again');
    assert.equal(await chrome.stable('window.__approvalCalls'), 1);
    assert.ok(methods.length > 0 && methods.every(method => method === 'GET'), 'the stand-in only reads real private board state');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await new Promise(resolveClosed => server.close(resolveClosed));
    await live.stop();
  }
});

test('served connection reaches an authenticated API on another origin and path in Chrome [H5,N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the connection proof.');
  const box = machine();
  const alpha = project(box, 'remote phone demo');
  box.run(alpha.repo, 'add', 'web', 'Remote original');
  const view = await startView(box);
  const credential = 'test-only-bearer';
  const seen = [];
  const apiServer = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    seen.push({ path: req.url, method: req.method, authorization: req.headers.authorization, localKey: req.headers['x-pullboard-key'] });
    if (req.headers.authorization !== `Bearer ${credential}` || !req.url.startsWith('/mirror/api/v1/')) return res.writeHead(401).end(JSON.stringify({ error: 'bad supplied connection' }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = await fetchLive(view.base + req.url.slice('/mirror'.length), {
        method: req.method, headers: { 'x-pullboard-key': view.key, ...(req.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(10_000),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    } catch (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${apiServer.address().port}/mirror`;
  const pageServer = createServer((req, res) => {
    if (req.url === '/phone/index.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(cockpitPage('', { apiBase, apiHeaders: { authorization: `Bearer ${credential}` }, stylesheet: 'view.css' }));
    if (req.url === '/phone/view.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(resolve(import.meta.dirname, '../../src/view.css')));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${pageServer.address().port}/phone/index.html`, join(box.dir, 'remote-phone-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('typeof data === "object" && !!data?.project');
    assert.equal(await chrome.stable('data.project.items[0].title'), 'Remote original');
    await chrome.click(`document.querySelector('#new-item')`); await chrome.stable(`document.querySelector('#add-title').value = 'Remote added'`); await chrome.stable(`document.querySelector('#add-form').requestSubmit()`);
    await chrome.waitFor('data.project.items.some(item => item.title === "Remote added")');
    assert.ok(seen.some((entry) => entry.method === 'POST' && entry.path.endsWith('/moves')), 'a real browser action reaches the configured API');
    assert.ok(seen.every((entry) => entry.authorization === `Bearer ${credential}` && entry.localKey === undefined && entry.path.startsWith('/mirror/api/v1/')), 'only the supplied credential and API base reach the stand-in');
    assert.ok(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),
      'the remote phone page fits the viewport content area');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await new Promise((resolve) => pageServer.close(resolve));
    await new Promise((resolve) => apiServer.close(resolve));
    await view.stop();
  }
});

test('relay person requests stay explicit, read-only and visible [H12,H5]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the person-request transport proof.');

  const box = machine();
  const requestRows = Array.from({ length: 12 }, (_, index) => `- P${index + 1} [draft, must] Keep the reading position measurable. | gate: test`).join('\n');
  const requestSpec = `# Person request fixture\n\n## G · Goals\n- G1 [approved, must] Existing item remains readable. | gate: test\n${requestRows}\n- G2 [draft, must] The person can approve this row. | gate: test\n`;
  const app = project(box, 'person requests', requestSpec);
  box.run(app.repo, 'add', 'web', 'Existing private item', '--specs', 'G1', '--criterion', 'remains readable');
  box.run(app.repo, 'shout', 'person', 'Should this item ship?', '--decision');
  const live = await startView(box);
  const intents = [];
  const records = [];
  const requestTimeline = [];
  let chrome;
  let diagnosticEmitted = false;
  /** Build the opted-in page or a refusal control with the same read-only transport. */
  const page = (options = {}) => cockpitPage('', {
    readOnly: true, requests: true, transportModule: '/transport.js', stylesheet: '/view.css', ...options,
  });
  const transportModule = `/** Provide the permitted stand-in transport while leaving real board reads untouched. */
  export async function createTransport({ onUpdate }) {
    window.__transportCalls = [];
    window.__setPersonRequest = async (id, status, error) => {
      await fetch('/request-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status, error }) });
      await onUpdate();
    };
    window.__holdNextIntent = false;
    window.__releaseHeldIntent = null;
    window.__pendingEarlierTransportCalls = 0;
    window.__lateEarlierTransportError = null;
    window.__releaseEarlierTransportCall = null;
    const transport = { async request(path, body) {
      window.__transportCalls.push({ path, body: body ?? null });
      if (body) {
        if (window.__holdNextIntent) {
          window.__holdNextIntent = false;
          await new Promise(resolve => { window.__releaseHeldIntent = resolve; });
        }
        const response = await fetch('/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      }
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      if (new URL(path, location.origin).pathname.endsWith('/state')) document.state.personRequests = await (await fetch('/request-state')).json();
      return document;
    } };
    /** Hold a genuine earlier read so the test can release it after taking a stale count. */
    window.__queueEarlierTransportCall = (path) => {
      window.__pendingEarlierTransportCalls += 1;
      window.__releaseEarlierTransportCall = () => {
        window.__releaseEarlierTransportCall = null;
        void transport.request(path).catch(error => { window.__lateEarlierTransportError = error.message; })
          .finally(() => { window.__pendingEarlierTransportCalls -= 1; });
      };
    };
    return transport;
  }`;
  /** Serve controlled request receipts and proxy reads to the actual private Git/SQLite board. */
  async function fixtureRequest(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const receivedAt = Date.now();
    if (url.pathname === '/request-state' && request.method === 'GET') {
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(records));
    }
    if (url.pathname === '/request-status' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const row = records.find(entry => entry.id === update.id);
      row.status = update.status;
      if (update.error) row.error = update.error;
      return response.writeHead(200).end();
    }
    if (url.pathname === '/intent' && request.method === 'POST') {
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-received', at: receivedAt });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const move = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const allowed = ['add', 'shout', 'answer', 'hold', 'spec-approve', 'spec-decline'].includes(move.verb)
        && Object.keys(move).every(key => ['verb', 'item', 'args'].includes(key));
      if (!allowed) return response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Only literal person requests are allowed.' } }));
      intents.push(structuredClone(move));
      const row = { id: 'request-' + intents.length, sequence: intents.length, at: '2026-10-08T00:00:00.000Z', by: 'person', move, status: 'waiting' };
      records.push(row);
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-accepted', at: Date.now(), id: row.id, verb: move.verb });
      response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-response-finished', at: Date.now(), id: row.id, status: response.statusCode }));
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: 1, event: { event_id: row.sequence, kind: 'request' }, result: { request: row } }));
    }
    if (url.pathname.startsWith('/fixture/')) {
      if (request.method !== 'GET') return response.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'The read-only fixture accepts GET only.' } }));
      const isState = url.pathname.endsWith('/state');
      if (isState) requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-start', at: receivedAt });
      const upstream = await fetchLive(live.base + url.pathname.slice('/fixture'.length) + url.search, { headers: { 'x-pullboard-key': live.key } });
      const text = await upstream.text();
      if (isState) requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-response', at: Date.now(), status: upstream.status });
      if (isState) response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-finished', at: Date.now(), status: response.statusCode }));
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(text);
    }
    response.writeHead(404).end();
  }
  /** Serve each capability control and the same-origin stand-in request protocol. */
  const pageServer = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/without-capability' || url.pathname === '/snapshot') {
      const body = url.pathname === '/'
        ? page({})
        : url.pathname === '/snapshot'
          ? cockpitPage('', { snapshot: true, requests: true, stylesheet: '/view.css' })
          : cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' });
      return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    }
    if (url.pathname.startsWith('/api/v1/') && url.pathname.endsWith('.json')) {
      const target = url.pathname.slice(0, -'.json'.length) + url.search;
      const upstream = await fetchLive(live.base + target, { headers: { 'x-pullboard-key': live.key } });
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(await upstream.text());
    }
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transportModule);
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(resolve(import.meta.dirname, '../../src/view.css')));
    return fixtureRequest(request, response);
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-person-request-chrome-'));
  scratch.push(profile);
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${pageServer.address().port}/`, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project && typeof window.__setPersonRequest === 'function'");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'the request view fits a phone viewport');
    assert.equal(await chrome.stable("document.body.classList.contains('requests') && getComputedStyle(document.querySelector('#new-item')).display !== 'none' && document.querySelector('#new-item').getBoundingClientRect().height >= 44"), true, 'the explicit capability exposes usable person controls');
    await chrome.click("document.querySelector('[data-tab=\"shouts\"]')"); await chrome.stable("document.querySelector('#shout-to').value = 'coordinator'"); await chrome.stable("document.querySelector('#shout-text').value = 'Please review this item.'"); await chrome.stable("document.querySelector('#shout-form').requestSubmit()");
    await chrome.waitFor("data?.project?.personRequests?.length === 1");
    assert.deepEqual(intents.at(-1), { verb: 'shout', args: { to: 'coordinator', text: 'Please review this item.' } });
    await chrome.click("document.querySelector('[data-tab=\"spec\"]')");
    await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.stable("document.querySelector('#spec-list [data-row=\"spec:G2\"]').scrollIntoView({ block: 'center' })");
    await chrome.waitFor('window.scrollY > 0');
    await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2'");
    const reading = JSON.parse(await chrome.stable(`JSON.stringify({ root: view.root, boardRoot: data.project.root, row: view.row.spec, scroll: window.scrollY,
      requestPanel: (() => { const node = document.querySelector('#person-requests'), rect = node.getBoundingClientRect(); return { hidden: node.hidden, top: rect.top, height: rect.height, documentTop: rect.top + scrollY, count: node.querySelectorAll('[data-person-request]').length }; })(),
      rowBox: (() => { const node = document.querySelector('#spec-list [data-row="spec:G2"]'), rect = node.getBoundingClientRect(); return { connected: node.isConnected, top: rect.top, height: rect.height, documentTop: rect.top + scrollY }; })(), pageHeight: document.documentElement.scrollHeight })`));
    assert.equal(reading.root, reading.boardRoot, 'the selected spec row belongs to the displayed board');
    assert.equal(reading.row, 'G2', 'G2 is the selected reading row before approval');
    await chrome.waitFor("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    assert.equal(await chrome.stable(`(() => {
      const usable = document.querySelector('#spec-detail button[data-row-decision="approve"]').getBoundingClientRect().height >= 44;
      const trace = window.__personRequestReadingTrace = { armedAt: performance.now(), events: [], mutationBatches: 0, scrollEvents: 0 };
      const box = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { connected: node.isConnected, hidden: Boolean(node.closest('[hidden]')), top: rect.top, bottom: rect.bottom,
          height: rect.height, documentTop: rect.top + scrollY, text: node.textContent.trim().slice(0, 100) };
      };
      const capture = (type, detail = {}) => {
        trace.events.push({ type, at: performance.now(), scrollY, pageHeight: document.documentElement.scrollHeight,
          panel: box('#person-requests'), row: box('#spec-list [data-row="spec:G2"]'),
          requestCount: document.querySelectorAll('#person-requests [data-person-request]').length,
          active: document.activeElement?.id || null, selectedRow: view.row.spec, tab: view.tab, ...detail });
        if (trace.events.length > 80) trace.events.splice(0, trace.events.length - 80);
      };
      trace.capture = capture;
      trace.serialize = () => ({ armedAt: trace.armedAt, mutationBatches: trace.mutationBatches, scrollEvents: trace.scrollEvents, events: trace.events });
      trace.observer = new MutationObserver(changes => {
        const relevant = changes.some(change => {
          const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
          return target?.closest?.('#person-requests, #spec-list') || [...change.addedNodes, ...change.removedNodes].some(node =>
            node.nodeType === 1 && (node.matches?.('#person-requests, #spec-list') || node.querySelector?.('#person-requests, #spec-list')));
        });
        if (!relevant) return;
        trace.mutationBatches += 1;
        capture('dom-mutation', { records: changes.length });
      });
      trace.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true,
        attributeFilter: ['hidden', 'class', 'style'] });
      trace.resize = new ResizeObserver(entries => capture('resize', { resized: entries.map(entry => entry.target.id || entry.target.dataset.row || entry.target.className).slice(0, 8) }));
      for (const node of [document.querySelector('#person-requests'), document.querySelector('#spec-list [data-row="spec:G2"]')]) if (node) trace.resize.observe(node);
      trace.onScroll = () => { trace.scrollEvents += 1; capture('scroll'); };
      window.addEventListener('scroll', trace.onScroll, { passive: true });
      trace.dispose = () => { trace.observer.disconnect(); trace.resize.disconnect(); window.removeEventListener('scroll', trace.onScroll); };
      capture('before-person-request');
      return usable;
    })()`), true, 'the real G2 approval control is usable at 375px');
    await chrome.stable('window.__holdNextIntent = true');
    await chrome.click("document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    await chrome.waitFor("typeof window.__releaseHeldIntent === 'function' || document.querySelector('#spec-detail .spec-feedback.no')");
    assert.equal(await chrome.stable("typeof window.__releaseHeldIntent"), 'function', 'the row decision reaches the sealed request transport instead of the refused generic API');
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback')?.textContent.trim() === 'Recording decision…'");
    await chrome.stable('window.__releaseHeldIntent()');
    await chrome.waitFor("document.querySelector('#spec-detail .spec-feedback') && document.querySelector('#spec-detail .spec-feedback').textContent.trim() !== 'Recording decision…'");
    assert.deepEqual(intents.at(-1), { verb: 'spec-approve', args: { ids: 'G2' } }, 'the detail click creates the exact second literal intent');
    await chrome.waitFor("data?.project?.personRequests?.length === 2 && document.querySelector('[data-person-request=\"request-2\"] .request-status')?.textContent === 'Waiting'");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback')?.textContent.trim() || ''"), /G2/);
    const afterApproval = JSON.parse(await chrome.stable(`JSON.stringify({ root: view.root, row: view.row.spec, scroll: window.scrollY, rowTop: document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.getBoundingClientRect().top, selected: document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.classList.contains('on'), visible: (() => { const row = document.querySelector('#spec-list [data-row=\"spec:G2\"]')?.getBoundingClientRect(); return !!row && row.top >= 0 && row.bottom <= innerHeight; })(), browserTrace: window.__personRequestReadingTrace?.serialize() ?? null })`));
    t.diagnostic(`person-request reading capture: ${JSON.stringify({ clocks: { browser: 'performance.now()', fixture: 'Date.now()' }, reading, afterApproval, requestTimeline })}`);
    diagnosticEmitted = true;
    assert.deepEqual([afterApproval.root, afterApproval.row, afterApproval.selected], [reading.root, 'G2', true], 'the request keeps the selected board and G2 row');
    assert.ok(Math.abs(afterApproval.rowTop - reading.rowBox.top) <= 1, 'the request keeps the row at the same viewport reading position');
    assert.equal(afterApproval.visible, true, 'G2 remains visible beside its inline feedback');
    assert.deepEqual(intents.at(-1), { verb: 'spec-approve', args: { ids: 'G2' } });
    assert.equal(await chrome.stable("data.project.spec.find(row => row.id === 'G2').decision === undefined"), true, 'waiting for a request never approves the row optimistically');
    await chrome.stable("window.__setPersonRequest('request-2', 'done')");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback')?.textContent || ''"), /^Done/, 'the same row feedback follows a matched done receipt');
    await chrome.stable("window.__setPersonRequest('request-2', 'refused', { code: 'REQUEST_DECLINED', message: 'Keep the row draft.', next: 'Ask the coordinator for the next step.' })");
    assert.match(await chrome.stable("document.querySelector('#spec-detail .spec-feedback.no')?.textContent || ''"), /Refused[\s\S]*REQUEST_DECLINED[\s\S]*Keep the row draft\.[\s\S]*Ask the coordinator/, 'the same row retains the original refusal and next step');
    await chrome.stable("window.__setPersonRequest('request-2', 'waiting')");

    const ids = JSON.parse(await chrome.stable('JSON.stringify(data.project.personRequests.map(row => row.id))'));
    assert.deepEqual(ids, ['request-1', 'request-2']);
    assert.ok(await chrome.stable("[...document.querySelectorAll('[data-person-request]')].length === 2 && [...document.querySelectorAll('[data-person-request]')].every(node => node.querySelector('.request-status').textContent === 'Waiting')"), 'waiting receipts render from API state');

    await t.test('a late earlier transport call is not counted as a refused write [H12]', { timeout: 30_000 }, async () => {
      /** Keep only calls with a write shape; unrelated earlier reads must not enter this count. */
      const writes = async () => JSON.parse(await chrome.stable(`JSON.stringify(window.__transportCalls.filter(call => call.body !== null || call.path.split('?')[0].endsWith('/moves')))`));
      const earlierPath = await chrome.stable(`boardPath(view.root) + '/state?lateEarlier=406'`);
      const beforeAllCalls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
      const beforeWrites = await writes();
      await chrome.stable(`window.__queueEarlierTransportCall(${JSON.stringify(earlierPath)})`);
      assert.equal(await chrome.stable('window.__pendingEarlierTransportCalls'), 1, 'the earlier read is held before it reaches the transport');
      assert.equal(await chrome.stable('window.__releaseEarlierTransportCall()'), undefined, 'the earlier read is released after the stale count');
      await chrome.waitFor(`(async () => {
        if (window.__pendingEarlierTransportCalls !== 0) return false;
        const count = window.__transportCalls.length;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return window.__pendingEarlierTransportCalls === 0 && count === window.__transportCalls.length;
      })()`);
      assert.equal(await chrome.stable('window.__lateEarlierTransportError'), null, 'the earlier read completed successfully');
      const afterEarlierCalls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
      assert.equal(beforeAllCalls.some(call => call.path === earlierPath), false, 'the delayed call was not in the earlier snapshot');
      assert.equal(afterEarlierCalls.filter(call => call.path === earlierPath && call.body === null).length, 1, 'the deliberately delayed earlier read reaches the transport once');
      const afterEarlierWrites = await writes();
      assert.deepEqual(afterEarlierWrites, beforeWrites, `the late read does not change the write-shaped transport calls: ${JSON.stringify(afterEarlierWrites)}`);

      // A generic write and an unknown action are refused before they reach the stand-in transport.
      const beforeRefused = intents.length;
      const beforeTransport = beforeWrites.length;
      const apiRefusal = await chrome.stable(`(async () => { try { await api(boardPath(view.root) + '/moves', { verb: 'shout', args: { to: 'coordinator', text: 'direct writes stay refused' } }); return 'unexpected'; } catch (error) { return error.message; } })()`);
      const execRefusal = await chrome.stable(`(async () => act('exec', { command: 'true' }))()`);
      const afterRefused = await writes();
      assert.equal(afterRefused.length, beforeTransport, `refused writes never reach the browser transport; extra call shapes: ${JSON.stringify(afterRefused.slice(beforeTransport))}`);
      assert.equal(intents.length, beforeRefused, 'refused shapes never reach the request server');
      assert.match(apiRefusal, /read-only view/i);
      assert.equal(execRefusal, false);
    });

    const longTitle = 'Requested item ' + 'abcdefghij'.repeat(24);
    const otherActions = [
      ['add', { lane: 'web', title: longTitle, criterion: 'visible', specs: 'G1', brief: 'requested work' }, { verb: 'add', args: { lane: 'web', title: longTitle, criterion: 'visible', specs: 'G1', brief: 'requested work' } }],
      ['answer', { id: 1, text: 'Ship it' }, { verb: 'answer', item: 1, args: { text: 'Ship it', as: 'person' } }],
      ['hold', { lane: 'web', reason: 'Wait for the decision' }, { verb: 'hold', args: { lane: 'web', reason: 'Wait for the decision' } }],
      ['release', { lane: 'web' }, { verb: 'hold', args: { lane: 'web', off: true } }],
      ['spec-decline', { ids: 'G2', reason: 'Keep the present behavior' }, { verb: 'spec-decline', args: { ids: 'G2', reason: 'Keep the present behavior' } }],
    ];
    for (const [action, args, expected] of otherActions) {
      assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), true, `${action} is a permitted person request`);
      assert.deepEqual(intents.at(-1), expected, `${action} retains literal public CLI intent`);
    }
    const allActions = [['shout', { to: 'coordinator', text: 'must not send' }], ['spec-approve', { ids: 'G2' }], ...otherActions.map(([action, args]) => [action, args])];

    // The no-capability read-only page and static snapshot cannot send person requests either.
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/without-capability` });
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.body?.classList.contains('read-only')");
    const beforeDisabled = intents.length;
    await chrome.click("document.querySelector('[data-tab=\"spec\"]')"); await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2'");
    assert.equal(await chrome.stable(`(async () => decideRow('spec', 'spec-approve', { ids: 'G2' }, document.querySelector('#spec-list [data-row=\"spec:G2\"]')))()`), false, 'the decision handler itself refuses without request capability');
    assert.equal(await chrome.stable('!view.specFeedback'), true, 'a disabled decision refuses before creating decision feedback');
    assert.equal(intents.length, beforeDisabled, 'a direct no-capability decision never reaches the request transport');
    for (const [action, args] of allActions) assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), false, `${action} stays refused without the capability`);
    assert.equal(intents.length, beforeDisabled, 'read-only without the explicit request capability refuses every action');
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/snapshot` });
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.body?.classList.contains('snapshot')");
    assert.equal(await chrome.stable(`(async () => decideRow('spec', 'spec-approve', { ids: 'G2' }, null))()`), false, 'the decision handler itself refuses in a snapshot');
    for (const [action, args] of allActions) assert.equal(await chrome.stable(`act(${JSON.stringify(action)}, ${JSON.stringify(args)})`), false, `${action} stays refused in a snapshot`);
    assert.match(await chrome.stable(`(async () => { try { await api('/api/v1/boards/demo/moves', { verb: 'shout' }); return 'unexpected'; } catch (error) { return error.message; } })()`), /read-only snapshot/i);
    assert.equal(intents.length, beforeDisabled, 'snapshot mode cannot use the explicit request capability');

    // A later actual API read may update status; refusal text is safe text and preserves CLI guidance.
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${pageServer.address().port}/` });
    await chrome.waitFor("typeof window.__setPersonRequest === 'function' && !!data?.project");
    await chrome.stable(`window.__setPersonRequest('request-1', 'done')`);
    await chrome.waitFor("document.querySelector('[data-person-request=\"request-1\"]')?.querySelector('.request-status')?.textContent === 'Done'");
    const refusal = '<img src=x onerror=globalThis.requestInjection=true> UNKNOWN_SPEC; run pullboard spec check';
    await chrome.stable(`window.__setPersonRequest('request-2', 'refused', { code: 'UNKNOWN_SPEC', message: ${JSON.stringify(refusal)}, next: 'run pullboard spec check' })`);
    await chrome.waitFor("document.querySelector('[data-person-request=\"request-2\"]')?.textContent.includes('UNKNOWN_SPEC')");
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"] img') === null"), true, 'refusal guidance is escaped, not interpreted as markup');
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"] .request-error')?.textContent"), 'UNKNOWN_SPEC ' + refusal, 'the original CLI refusal message stays intact');
    assert.equal(await chrome.stable('globalThis.requestInjection === undefined'), true, 'refusal content cannot execute in the page');
    assert.equal(await chrome.stable("document.querySelector('[data-person-request=\"request-2\"]')?.textContent.includes('run pullboard spec check')"), true);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, `${width}px refusal view has no horizontal overflow`);
      const layout = JSON.parse(await chrome.stable(`JSON.stringify({
        statuses: [...document.querySelectorAll('.request-status')].map(node => node.textContent),
        listFits: document.querySelector('.request-list').scrollWidth <= document.querySelector('.request-list').clientWidth,
        readable: [...document.querySelectorAll('.request-label, .request-status, .request-error, .request-next')].every(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && parseFloat(getComputedStyle(node).fontSize) >= 12;
        })
      })`));
      for (const status of ['Waiting', 'Done', 'Refused']) assert.ok(layout.statuses.includes(status), `${width}px renders ${status} from documented request status`);
      assert.equal(layout.listFits, true, `${width}px keeps the request list inside its panel`);
      assert.equal(layout.readable, true, `${width}px keeps request labels and refusal guidance readable`);
    }
    assert.deepEqual(intents, [
      { verb: 'shout', args: { to: 'coordinator', text: 'Please review this item.' } },
      { verb: 'spec-approve', args: { ids: 'G2' } },
      ...otherActions.map(([, , expected]) => expected),
    ]);
    const privatePath = await chrome.stable('boardPath(view.root)');
    const privateState = await (await fetchLive(live.base + privatePath + '/state', { headers: { 'x-pullboard-key': live.key } })).json();
    assert.equal(privateState.state.items.length, 1, 'the stand-in request transport never executes an item move on the real board');
    assert.equal(privateState.state.holds.length, 0, 'the request transport never changes a real lane hold');
    assert.equal(privateState.state.shouts.length, 1, 'the request transport never posts a direct shout');
  } finally {
    if (chrome) {
      if (!diagnosticEmitted) {
        try {
          const browserTrace = await chrome.stable('window.__personRequestReadingTrace?.serialize() ?? null');
          t.diagnostic(`person-request reading capture on original outcome: ${JSON.stringify({ clocks: { browser: 'performance.now()', fixture: 'Date.now()' }, requestTimeline, browserTrace })}`);
        } catch (error) {
          t.diagnostic(`person-request reading capture unavailable: ${error.name}: ${error.message}; fixture timeline: ${JSON.stringify(requestTimeline)}`);
        }
      }
      await chrome.stable('window.__personRequestReadingTrace?.dispose(); delete window.__personRequestReadingTrace').catch(() => undefined);
      chrome.socket.close();
      await stopOwnedChrome(chrome.child, chrome.stopped);
    }
    await new Promise((resolve) => pageServer.close(resolve));
    await live.stop();
  }
});

test('a person request never moves the reading position under a 6× CPU throttle [N26]', { timeout: 120_000 }, async t => { // budget: hang-only ceiling for real Chrome startup, private board setup and the sixfold request journey.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the native sixfold person-request regression');

  const box = machine();
  const requestRows = Array.from({ length: 12 }, (_, index) => `- P${index + 1} [draft, must] Keep the reading position measurable. | gate: test`).join('\n');
  const spec = `# Person request fixture\n\n## G · Goals\n- G1 [approved, must] Existing item remains readable. | gate: test\n${requestRows}\n- G2 [draft, must] The person can approve this row. | gate: test\n`;
  const app = project(box, 'person request growth at sixfold CPU', spec);
  box.run(app.repo, 'add', 'web', 'Existing private item', '--specs', 'G1', '--criterion', 'remains readable');
  const live = await startView(box);
  const intents = [];
  const records = [];
  const requestTimeline = [];
  let chrome;
  let server;
  let traceArmed = false;
  /** Provide only the sealed person-request intent and actual private board reads. */
  const transportModule = `export async function createTransport() {
    return { async request(path, body) {
      if (body) {
        const response = await fetch('/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      }
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      return document;
    } };
  }`;
  /** Serve the request receipts while proxying each board read to the real private view. */
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(cockpitPage('', { readOnly: true, requests: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transportModule);
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' })
      .end(readFileSync(resolve(import.meta.dirname, '../../src/view.css')));
    if (url.pathname === '/intent' && request.method === 'POST') {
      const receivedAt = Date.now();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const move = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      intents.push(move);
      const row = { id: `request-${intents.length}`, sequence: intents.length, at: new Date(receivedAt).toISOString(), by: 'person', move, status: 'waiting' };
      records.push(row);
      requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-accepted', at: receivedAt, id: row.id, verb: move.verb });
      response.once('finish', () => requestTimeline.push({ clock: 'fixture-Date.now', type: 'intent-response-finished', at: Date.now(), id: row.id, status: response.statusCode }));
      return response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ version: 1, event: { event_id: row.sequence, kind: 'request' }, result: { request: row } }));
    }
    if (url.pathname.startsWith('/fixture/')) {
      const receivedAt = Date.now();
      const upstream = await fetchLive(live.base + url.pathname.slice('/fixture'.length) + url.search, { headers: { 'x-pullboard-key': live.key } });
      const body = await upstream.json();
      if (url.pathname.endsWith('/state')) {
        requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-start', at: receivedAt });
        body.state.personRequests = structuredClone(records);
        requestTimeline.push({ clock: 'fixture-Date.now', type: 'state-read-response', at: Date.now(), status: upstream.status });
      }
      return response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }
    return response.writeHead(404).end();
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${server.address().port}/`, join(box.dir, 'person-request-growth-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
      'the 375px person-request view fits the viewport');
    await press(chrome, "document.querySelector('[data-tab=\"shouts\"]')");
    await chrome.stable("document.querySelector('#shout-to').value = 'person'");
    await chrome.stable("document.querySelector('#shout-text').value = 'Should this item ship?'");
    await chrome.stable("document.querySelector('#shout-form').requestSubmit()");
    await chrome.waitFor('data?.project?.personRequests?.length === 1');
    assert.deepEqual(intents[0], { verb: 'shout', args: { to: 'person', text: 'Should this item ship?' } },
      'the initial request is an actual literal person intent');

    await press(chrome, "document.querySelector('[data-tab=\"spec\"]')");
    await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.stable("document.querySelector('#spec-list [data-row=\"spec:G2\"]').scrollIntoView({ block: 'center', behavior: 'instant' })");
    await chrome.waitFor('window.scrollY > 0');
    await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    await chrome.waitFor("view.row.spec === 'G2' && document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    const throttleResponse = await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const throttle = { requestedRate: 6, commandResolved: true, protocolResponse: throttleResponse ?? null,
      computed: JSON.parse(await chrome.stable(`JSON.stringify({ viewport:{ width:innerWidth, height:innerHeight }, dpr:devicePixelRatio,
      body:{ fontSize:getComputedStyle(document.body).fontSize, lineHeight:getComputedStyle(document.body).lineHeight } })`)),
    };
    assert.equal(throttle.requestedRate, 6, 'the real Chrome throttle command requests sixfold CPU slowdown');
    assert.equal(throttle.commandResolved, true, 'the CPU-throttle command is acknowledged before the measured action');
    assert.deepEqual(throttle.computed.viewport, { width: 375, height: 900 }, 'the mutation-time capture uses the required phone viewport');
    const before = JSON.parse(await chrome.stable(`JSON.stringify({ scrollY, requestCount:document.querySelectorAll('#person-requests [data-person-request]').length,
      panel:(()=>{const n=document.querySelector('#person-requests'),r=n.getBoundingClientRect();return{height:r.height,documentTop:r.top+scrollY,overflowAnchor:getComputedStyle(n).overflowAnchor}})(),
      row:(()=>{const n=document.querySelector('#spec-list [data-row=\"spec:G2\"]'),r=n.getBoundingClientRect();return{connected:n.isConnected,top:r.top,documentTop:r.top+scrollY,height:r.height}})(),
      approveHeight:document.querySelector('#spec-detail button[data-row-decision=\"approve\"]').getBoundingClientRect().height })`));
    assert.equal(before.requestCount, 1, 'the person panel begins with one existing request');
    assert.ok(before.approveHeight >= 44, 'the actual approval target remains usable');
    assert.ok(before.scrollY > 0 && before.row.connected, 'the selected G2 row starts at a real scrolled reading position');
    await chrome.stable(`(() => {
      const box = () => {
        const panel=document.querySelector('#person-requests'), row=document.querySelector('#spec-list [data-row="spec:G2"]');
        const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{connected:node.isConnected,top:r.top,bottom:r.bottom,documentTop:r.top+scrollY,height:r.height}};
      return { at:performance.now(), scrollY, pageHeight:document.documentElement.scrollHeight,
          requestCount:panel.querySelectorAll('[data-person-request]').length, panel:rect(panel), row:rect(row),
          pageOverflowAnchor:getComputedStyle(document.documentElement).overflowAnchor, selected:view.row.spec };
      };
      const nativeScrollTo=window.scrollTo;
      const trace=window.__personRequestGrowthTrace={ initial:box(), events:[], mutationBatches:0, growth:null, scrollToCalls:[], preRestore:null, disposed:false };
      trace.snapshot=box;
      window.scrollTo=function(...args){
        const before=box();
        const growingPanel=before.requestCount===2 && before.panel.height>trace.initial.panel.height;
        if(growingPanel && !trace.preRestore)trace.preRestore={args,before};
        const result=nativeScrollTo.apply(window,args);
        const after=box();
        if(trace.scrollToCalls.length<12)trace.scrollToCalls.push({args,before,after});
        if(growingPanel && trace.preRestore && !trace.preRestore.after)trace.preRestore.after=after;
        return result;
      };
      trace.observer=new MutationObserver(changes=>{
        if(trace.disposed)return;
        const relevant=changes.some(change=>{
          const target=change.target.nodeType===1?change.target:change.target.parentElement;
          return target?.closest?.('#person-requests, #spec-list') || [...change.addedNodes,...change.removedNodes].some(node=>
            node.nodeType===1 && (node.matches?.('#person-requests, #spec-list') || node.querySelector?.('#person-requests, #spec-list')));
        });
        if(!relevant)return;
        trace.mutationBatches+=1;
        const sample=box();
        if(trace.events.length<40)trace.events.push(sample);
        if(sample.requestCount===2 && !trace.growth)trace.growth=sample;
      });
      trace.observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true,attributeFilter:['hidden','class','style']});
      trace.dispose=()=>{trace.disposed=true;trace.observer.disconnect();window.scrollTo=nativeScrollTo;};
    })()`);
    traceArmed = true;
    await press(chrome, "document.querySelector('#spec-detail button[data-row-decision=\"approve\"]')");
    await chrome.waitFor("data?.project?.personRequests?.length === 2 && document.querySelector('[data-person-request=\"request-2\"] .request-status')?.textContent === 'Waiting'");
    const capture = JSON.parse(await chrome.stable('JSON.stringify({ ...window.__personRequestGrowthTrace, settled: window.__personRequestGrowthTrace.snapshot() })'));
    assert.ok(capture?.growth, 'the actual second-request DOM mutation captures the panel-growth instant');
    assert.equal(capture.growth.requestCount, 2, 'the captured mutation contains the real second request');
    assert.ok(capture.growth.panel.height > before.panel.height, 'the person panel grew before the browser movement assertion');
    const positions = [capture.initial, ...capture.events, ...capture.scrollToCalls.flatMap(call => [call.before, call.after]), capture.settled];
    for (const position of positions) {
      assert.ok(position.row?.connected, 'the reading row remains present through each redraw and restoration');
      assert.ok(Math.abs(position.row.top - before.row.top) <= 1,
        `the row stays at viewport top ${before.row.top} through request growth: ${JSON.stringify(position)}`);
    }
    assert.equal(capture.growth.selected, 'G2', 'the selected reading row stays the same through panel growth');
    assert.deepEqual(intents[1], { verb: 'spec-approve', args: { ids: 'G2' } }, 'the measured action is the real G2 approval request');
    t.diagnostic(`sixfold person-request growth capture: ${JSON.stringify({ throttle, before, capture, intent:intents[1], timeline:requestTimeline,
      clocks:{ browser:'performance.now()', fixture:'Date.now()' } })}`);
  } finally {
    if (chrome) {
      if (traceArmed) {
        try {
          const trace=await chrome.stable('JSON.stringify(window.__personRequestGrowthTrace ?? null)');
          t.diagnostic(`sixfold person-request growth trace on original outcome: ${trace}`);
        } catch (error) { t.diagnostic(`sixfold person-request trace unavailable: ${error.name}: ${error.message}; timeline=${JSON.stringify(requestTimeline)}`); }
        await chrome.stable('window.__personRequestGrowthTrace?.dispose(); delete window.__personRequestGrowthTrace').catch(() => undefined);
      }
      await chrome.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await new Promise(resolvePromise => server.close(resolvePromise));
    await live.stop();
  }
});

test('read-only Needs-you preserves each entry as text while its transport stays read-only [N26,N27,B26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the browser transport proof.');

  const box = machine();
  const app = project(box, 'read only transport', `${SPEC}- G3 [pending, must] Confirm the read-only question. | gate: review\n- G4 [draft, must] Confirm the draft row. | gate: review\n`);
  box.run(app.repo, 'add', 'web', 'Read-only fixture item', '--specs', 'G1', '--criterion', 'keeps action controls in the DOM');
  box.run(app.repo, 'shout', 'person', 'Should the read-only fixture ship?', '--decision');
  box.run(app.repo, 'hold', 'web', '--reason', 'read-only fixture hold');
  const live = await startView(box);
  const pageKey = 'page-relay-secret';
  const headerKey = 'header-relay-secret';
  const page = cockpitPage(pageKey, {
    readOnly: true,
    transportModule: '/transport.js',
    apiBase: 'https://private.invalid/board?secret=api-base-secret',
    apiHeaders: { 'x-pullboard-key': headerKey },
    stylesheet: '/view.css',
  });
  for (const secret of [pageKey, headerKey, 'api-base-secret']) assert.equal(page.includes(secret), false, 'custom transport page options do not expose API credentials');
  assert.throws(() => cockpitPage('', { transportModule: '' }), /transportModule/);

  const forwarded = [];
  const moduleSource = `export async function createTransport({ onUpdate }) {
    window.__transportCalls = [];
    window.__transportUpdate = onUpdate;
    return { async request(path, body) {
      window.__transportCalls.push({ path, body: body ?? null });
      const response = await fetch('/fixture' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const document = await response.json();
      if (!response.ok) throw new Error(document.error?.message || String(response.status));
      return document;
    } };
  }`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/missing') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    if (url.pathname === '/transport.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(moduleSource);
      return;
    }
    if (url.pathname === '/view.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(readFileSync(new URL('../../src/view.css', import.meta.url), 'utf8'));
      return;
    }
    if (!url.pathname.startsWith('/fixture/')) {
      response.writeHead(404).end();
      return;
    }
    const target = url.pathname.slice('/fixture'.length) + url.search;
    const headers = { 'x-pullboard-key': live.key };
    if (request.method !== 'GET') {
      forwarded.push(request.method);
      response.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'fixture transport accepts reads only' }));
      return;
    }
    forwarded.push(request.method);
    fetchLive(live.base + target, { headers }).then(async (reply) => {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(await reply.text());
    }).catch((error) => {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error.message || error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-transport-chrome-'));
  scratch.push(profile);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, live.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project && document.querySelector('#needs .row')?.textContent.includes('Should the read-only fixture ship?')");
    /** Read Needs-you labels with absolute API age timestamps so the comparison survives minute ticks. */
    const readNeedEntries = () => chrome.stable(`JSON.stringify([...document.querySelectorAll('#needs .row')].map((row) => {
      const time = row.querySelector('.row-age time'), ref = row.querySelector('.t > span');
      return [ref?.textContent, row.querySelector('.t').textContent.slice((ref?.textContent ?? '').length),
        row.querySelector('.meta .why').textContent + (time ? ' @' + time.dataset.ago : '')];
    }))`);
    const normalEntries = JSON.parse(await readNeedEntries());
    assert.deepEqual(normalEntries.map((row) => row[0]), [null, 'G3', 'web', '1'], 'the normal Needs-you list contains the decision, pending row, held lane, and draft summary');
    assert.match(normalEntries[0][2], /^NEEDS YOU a decision, asked by coordinator \(unknown\) @[^ ]+$/, 'the API-provided decision timestamp is shown as an age');
    assert.match(normalEntries[2][2], /^NEEDS YOU lane held by coordinator \(unknown\) @[^ ]+$/, 'the holder and API-provided hold timestamp are shown as an age');
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
    await chrome.waitFor("typeof data === 'object' && document.body?.classList.contains('read-only') && !!data?.project && typeof window.__transportUpdate === 'function'");
    await chrome.waitFor("document.querySelector('#needs .row')?.textContent.includes('Should the read-only fixture ship?')");
    const readOnlyEntries = JSON.parse(await readNeedEntries());
    assert.deepEqual(readOnlyEntries, normalEntries, 'read-only Needs-you preserves the normal entries and their API-provided asker and ages');
    assert.equal(await chrome.stable("document.querySelectorAll('#needs button, #needs [data-go], #needs [data-new], #needs [data-shout], #needs [data-release]').length"), 0,
      'read-only Needs-you entries contain no answer, approve, navigation, or other action controls');
    const calls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
    assert.ok(calls.some((call) => call.path === '/api/v1/boards'));
    assert.ok(calls.some((call) => call.path.startsWith('/api/v1/boards/') && call.path.endsWith('/state')));
    assert.equal(await chrome.stable("document.querySelector('#live').textContent"), '', 'read-only transport keeps the page live, which says nothing');
    const actionSelectors = ['#new-item', '#add-form', '#shout-form', '#hold-form', '[data-release]', '[data-shout]', '[data-new]', '[data-go^="decide:"]'];
    const actionMatches = JSON.parse(await chrome.stable(`JSON.stringify(${JSON.stringify(actionSelectors)}.map((selector) => ({ selector, count: document.querySelectorAll(selector).length, visible: [...document.querySelectorAll(selector)].some((node) => !node.hidden && getComputedStyle(node).display !== 'none') })))`));
    assert.ok(actionMatches.every((entry) => entry.count > 0), 'the seeded item, decision and hold exercise every action selector');
    assert.deepEqual(actionMatches.filter((entry) => entry.visible).map((entry) => entry.selector), [], 'read-only mode hides every match for every action control');

    const refusedAction = JSON.parse(await chrome.stable(`(async () => JSON.stringify({ result: await act('shout', { to: 'all', text: 'blocked' }), message: document.querySelector('#console').textContent }))()`));
    assert.equal(refusedAction.result, false);
    assert.match(refusedAction.message, /read-only/i);
    const refusedApi = await chrome.stable(`(async () => { try { await api('/api/v1/boards/demo/moves', { verb: 'shout' }); return 'unexpected success'; } catch (error) { return error.message; } })()`);
    assert.match(refusedApi, /read-only/i, 'direct API mutation calls are refused before transport');
    assert.ok(forwarded.every((method) => method === 'GET'), 'read-only action attempts send no write through the transport');

    await chrome.stable(`window.__samePage = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })`);
    box.run(app.repo, 'add', 'web', 'Transport refresh item', '--specs', 'G1', '--criterion', 'appears after a transport update');
    await chrome.stable('window.__transportUpdate()');
    assert.equal(await chrome.stable("data?.project?.items.some((item) => item.title === 'Transport refresh item') && window.__samePage === true"), true, 'onUpdate refreshes state in the same page without relying on the poll');
    assert.ok(forwarded.every((method) => method === 'GET'), 'transport update refreshed through reads only');

  } finally {
    if (chrome) {
      chrome.socket.close();
      await stopOwnedChrome(chrome.child, chrome.stopped);
    }
    await live.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a configured transport never falls back while loading or after import failure [N26,N27]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the transport startup proof.');

  const box = machine();
  const demo = project(box, 'transport-startup');
  box.run(demo.repo, 'add', 'web', 'Transport startup item', '--specs', 'G1', '--criterion', 'loads through the configured transport');
  const live = await startView(box);
  const slowPage = cockpitPage('', { transportModule: '/slow-transport.js' });
  const failedPage = cockpitPage('', { transportModule: '/failed-transport.js' });
  const localRequests = [];
  const relayRequests = [];
  let slowModuleRequested;
  const requested = new Promise((resolve) => { slowModuleRequested = resolve; });
  let releaseSlowModule;
  const slowModuleBarrier = new Promise((resolve) => { releaseSlowModule = resolve; });
  const transportSource = `export async function createTransport() {
    window.__transportReady = true;
    window.__transportCalls = [];
    return { async request(path, body) {
      window.__transportCalls.push(path);
      const response = await fetch('/relay' + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
      return response.json();
    } };
  }`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/slow' || url.pathname === '/failed') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(url.pathname === '/slow' ? slowPage : failedPage);
      return;
    }
    if (url.pathname === '/slow-transport.js') {
      slowModuleRequested();
      await slowModuleBarrier;
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(transportSource);
      return;
    }
    if (url.pathname === '/failed-transport.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end("throw new Error('fixture transport import failed');");
      return;
    }
    if (url.pathname === '/view.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(readFileSync(new URL('../../src/view.css', import.meta.url), 'utf8'));
      return;
    }
    if (url.pathname.startsWith('/relay/')) {
      const path = url.pathname.slice('/relay'.length) + url.search;
      relayRequests.push(path);
      try {
        const reply = await fetchLive(live.base + path, { headers: { 'x-pullboard-key': live.key } });
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(await reply.text());
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error.message || error) }));
      }
      return;
    }
    if (url.pathname.startsWith('/api/v1/')) {
      localRequests.push(url.pathname);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'LOCAL_FALLBACK', message: 'the page-local API must not be used' } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-transport-startup-chrome-'));
  let chrome;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    chrome = await openSnapshotChrome(executable, `${origin}/slow`, profile);
    await requested;
    const loadingCall = await chrome.stable("api('/api/v1/boards').then(() => 'unexpected success', error => error.message)");
    assert.match(loadingCall, /transport.*loading/i, 'direct API calls refuse while the configured module is loading');
    await browserPause(3200);
    assert.equal(await chrome.stable('window.__transportReady === true'), false, 'the delayed module is still loading during the proof');
    assert.deepEqual(localRequests, [], 'neither direct reads nor the poll fall back while loading');

    releaseSlowModule();
    await chrome.waitFor('window.__transportReady === true && !!data?.project');
    assert.ok(relayRequests.includes('/api/v1/boards'), 'the initial board read uses the configured transport');
    assert.deepEqual(localRequests, [], 'loading the configured module never touched the page-local API');

    await chrome.send('Page.navigate', { url: `${origin}/failed` });
    await chrome.waitFor("document.querySelector('#live').textContent.includes('fixture transport import failed')");
    await browserPause(3200);
    assert.match(await chrome.stable("document.querySelector('#live').textContent"), /cannot reach the view: fixture transport import failed/,
      'the original module error remains visible after later poll intervals');
    assert.deepEqual(localRequests, [], 'a failed import also disables page-local polling');
  } finally {
    releaseSlowModule();
    if (chrome) await closeSnapshotChrome(chrome);
    await live.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});

const JOURNEY_HOSTED = 'https://app.pullboard.dev';
const JOURNEY_LOCAL = 'http://127.0.0.1:4890';

/** Serve the relay's real browser page and proxy its API to the loopback relay fixture. */
async function journeyRelaySite(box, localOrigin) {
  const browser = createRelayBrowserHandler({
    async authenticate(req) {
      const token = /(?:^|;\s*)pb_session=([^;]+)/u.exec(req.headers.cookie || '')?.[1];
      if (!token) return { kind: 'anonymous' };
      try { return await box.auth.authenticate(token); } catch { return { kind: 'anonymous' }; }
    },
  });
  const server = createServer((req, res) => {
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, headers, ...rest) => {
      if (headers && !Array.isArray(headers)) {
        const csp = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy');
        if (csp) headers[csp] = headers[csp].replace("connect-src 'self'", "connect-src 'self' " + localOrigin);
      }
      return writeHead(status, headers, ...rest);
    };
    void (async () => {
      if (await browser(req, res)) return;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': JOURNEY_HOSTED,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': req.headers['access-control-request-headers'] || 'content-type',
          'access-control-allow-private-network': 'true', vary: 'Origin',
        });
        return res.end();
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !['host', 'connection', 'content-length'].includes(name.toLowerCase())));
      // As in the real exit journey, translate only the private upstream's configured origin.
      headers.origin = box.origin;
      const upstream = request(new URL(req.url, box.origin), { method: req.method, headers, agent: false }, (reply) => {
        const responseHeaders = Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !['connection', 'transfer-encoding', 'keep-alive', 'access-control-allow-origin', 'access-control-allow-credentials'].includes(name.toLowerCase())));
        responseHeaders['access-control-allow-origin'] = JOURNEY_HOSTED;
        responseHeaders['access-control-allow-credentials'] = 'true';
        responseHeaders.vary = 'Origin';
        res.writeHead(reply.statusCode || 502, responseHeaders);
        reply.pipe(res);
      });
      res.once('close', () => upstream.destroy());
      upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

/** Route the hosted page and its fixed loopback discovery through owned fixture servers. */
async function interceptJourneyOrigins(chrome, site, view, { deadline: currentDeadline, liveStreams = false } = {}) {
  const failures = [];
  let failureCount = 0;
  const tasks = [];
  const interceptions = [];
  let stopping = false;
  const byNetworkRequest = new Map();
  const earlyNetworkFailures = new Map();
  const networkFailureWaiters = new Set();
  const heldResponses = [];
  const releaseHeldResponses = new Set();
  /** Keep bounded CDP code/message detail without retaining unrelated protocol payloads. */
  function safeProtocolError(error) {
    let detail = error?.message ?? error;
    if (typeof detail === 'string') {
      try { detail = JSON.parse(detail); } catch { /* Keep ordinary Error messages below. */ }
    }
    if (detail && typeof detail === 'object') {
      const message = String(detail.message ?? 'unknown CDP error');
      return {
        ...(Number.isInteger(detail.code) ? { code: detail.code } : {}),
        message: /^[A-Za-z0-9 _.:/-]{1,180}$/u.test(message) ? message : '<redacted protocol error>',
      };
    }
    const message = String(detail ?? 'unknown error');
    return /^[A-Za-z0-9 _.:/-]{1,180}$/u.test(message) ? message : '<redacted protocol error>';
  }
  /** Describe only an owned fixture origin and a query-free path with board identities redacted. */
  function safeRequestAddress(url) {
    const address = new URL(url);
    const origin = address.origin === JOURNEY_HOSTED ? 'hosted'
      : address.origin === JOURNEY_LOCAL ? 'loopback-discovery'
        : address.origin === view.base ? 'local-view' : 'other';
    const path = address.pathname.replace(/\/api\/v1\/boards\/[0-9a-f]{32}(?=\/|$)/gu, '/api/v1/boards/<board>');
    return { origin, path };
  }
  /** Return request evidence without URL queries, headers, cookies, bodies or pairing values. */
  function safeInterception(record) {
    return {
      fetchRequestId: record.fetchRequestId,
      networkId: record.networkId ?? null,
      resourceType: record.resourceType ?? null,
      ...record.address,
      method: record.method,
      stage: record.stage,
      timing: record.timing,
      stopObserved: record.stopObserved,
      completionTiming: record.completionTiming ?? null,
      networkFailureTiming: record.networkFailureTiming ?? null,
      responseStatus: record.responseStatus ?? null,
      liveStream: record.liveStream === true,
      bodyCompleted: record.bodyCompleted,
      bodyBytes: record.bodyBytes,
      bodyBytesCapped: record.bodyBytesCapped,
      completionAttempts: record.completionAttempts,
      completion: record.completion ?? null,
      networkFailure: record.networkFailure ?? null,
      completed: record.completed,
      browserCanceled: record.browserCanceled === true,
      terminalCancellation: record.terminalCancellation === true,
      cancellationCorrelationExpired: record.cancellationCorrelationExpired === true,
    };
  }
  /** Bound diagnostics to failed/incomplete requests and a short recent tail. */
  function safeTrace() {
    const incomplete = interceptions.filter((record) => !isAccountedRequest(record));
    const canceledCount = interceptions.filter((record) => isConfirmedBrowserCancellation(record)).length;
    const failed = interceptions.filter((record) => record.failure).slice(0, 20);
    const canceled = interceptions.filter(isConfirmedBrowserCancellation).slice(0, 20);
    const relevant = new Set([...failed, ...incomplete.slice(0, 20), ...canceled, ...interceptions.slice(-8)]);
    return {
      requestCount: interceptions.length,
      liveStreamCount: interceptions.filter((record) => record.liveStream === true).length,
      failureCount,
      incompleteCount: incomplete.length,
      confirmedBrowserCancellationCount: canceledCount,
      requests: [...relevant].map(safeInterception),
      failures: failures.slice(0, 20),
    };
  }
  /** Send exactly one Fetch completion for a paused request and retain its protocol outcome. */
  async function completePausedRequest(record, method, params) {
    assert.equal(String(params.requestId), record.fetchRequestId, 'Fetch completion belongs to this exact paused request');
    if (record.completionAttempts === 0 && isConfirmedBrowserCancellation(record)) return;
    record.completionAttempts += 1;
    if (record.completionAttempts !== 1) {
      record.stage = 'duplicate-completion-refused';
      throw new Error('a paused request received more than one Fetch completion command');
    }
    record.completionTiming = stopping ? 'during-stop' : 'active';
    record.completion = { method, commandSent: true, status: 'pending', timing: record.completionTiming };
    record.stage = 'completion-command-sent';
    try {
      await chrome.send(method, params);
      record.completion.status = 'resolved';
      record.completed = true;
      record.stage = 'completed';
    } catch (error) {
      record.completion.status = 'rejected';
      record.completion.error = safeProtocolError(error);
      record.stage = 'completion-command-rejected';
      throw error;
    }
  }
  /** Consider only one rejected fulfill for this exact owned request for bounded cancellation correlation. */
  function isAbortCompletionCandidate(record) {
    const error = record.completion?.error;
    return record.networkId !== null && record.address.origin !== 'other'
      && record.completion?.method === 'Fetch.fulfillRequest'
      && record.completionAttempts === 1
      && record.completion?.status === 'rejected'
      && error?.code === -32602
      && (error.message === 'Invalid InterceptionId.' || error.message === 'Invalid InterceptionId');
  }
  /** Recognize the candidate only after this request's own matching-phase browser cancellation arrives. */
  function isObservedAbortCompletionRace(record) {
    return isAbortCompletionCandidate(record) && record.browserCanceled === true
      && record.networkFailure?.canceled === true
      && record.networkFailureTiming === record.completionTiming;
  }
  /** Count only a completion or the exactly correlated browser-abort terminal outcome. */
  function isConfirmedBrowserCancellation(record) {
    if (!record.terminalCancellation || !record.browserCanceled || !record.networkId || record.address.origin === 'other' || record.networkFailure?.canceled !== true) return false;
    if (record.completionAttempts === 0) return true;
    return isObservedAbortCompletionRace(record);
  }
  /** Require every paused request to finish once or meet the narrow cancellation rule. */
  function isAccountedRequest(record) {
    return (record.completed && record.completionAttempts === 1) || isConfirmedBrowserCancellation(record);
  }
  /** Mark a request terminally cancelled only when its own network event confirms the abort. */
  function markObservedAbort(record) {
    record.browserCanceled = true;
    if (record.completed) return;
    record.terminalCancellation = true;
    record.stage = 'browser-cancelled';
    record.abortController?.abort();
    record.releaseHeldResponse?.();
  }
  /** Drain all dynamic batches against the caller's one absolute cleanup deadline. */
  async function drainTasks() {
    return drainJourneyTasks(tasks, currentDeadline());
  }
  /** Abort only outbound reads and release holds owned by this private fixture after failure. */
  function cancelOwned(reason) {
    for (const held of heldResponses.splice(0)) held.cancel();
    for (const release of releaseHeldResponses) release();
    const reads = [];
    for (const record of interceptions) {
      record.abortController?.abort(reason);
      if (record.reader) reads.push(record.reader.cancel());
    }
    return Promise.allSettled(reads);
  }
  /** Retain cancellation and error details keyed only by the ephemeral CDP network id. */
  function onNetworkFailure(params) {
    const details = {
      type: String(params.type ?? '').slice(0, 40),
      errorText: /^[A-Za-z0-9_:.-]{1,100}$/u.test(params.errorText ?? '') ? params.errorText : '<redacted>',
      canceled: Boolean(params.canceled),
      timing: stopping ? 'during-stop' : 'active',
      ...(params.blockedReason ? { blockedReason: String(params.blockedReason).slice(0, 60) } : {}),
    };
    const id = String(params.requestId ?? '');
    const records = byNetworkRequest.get(id);
    if (!records?.length) {
      const prior = earlyNetworkFailures.get(id) ?? [];
      prior.push(details);
      earlyNetworkFailures.set(id, prior);
      return;
    }
    for (const record of records) {
      record.networkFailure = details;
      record.networkFailureTiming = details.timing;
      if (details.canceled) markObservedAbort(record);
    }
    for (const check of networkFailureWaiters) check();
  }
  /** Wait for a correlated network failure without retaining request credentials or bodies. */
  function waitForNetworkFailure(matches) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { // budget: 10s hang ceiling for the private request-failure handshake; journey deadline owns total runtime.
        networkFailureWaiters.delete(check);
        reject(new Error('the owned browser request did not report its expected network failure within 10 seconds'));
      }, 10_000);
      function check() {
        const record = interceptions.find((entry) => matches(entry) && entry.networkFailure);
        if (!record) return;
        clearTimeout(timer);
        networkFailureWaiters.delete(check);
        resolve(safeInterception(record));
      }
      networkFailureWaiters.add(check);
      check();
    });
  }
  const holdNextResponse = (matches) => {
    let entry;
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { // budget: 10s hang ceiling for the fixture to observe one held response; journey deadline owns total runtime.
        const index = heldResponses.indexOf(entry);
        if (index !== -1) heldResponses.splice(index, 1);
        reject(new Error('The real API response did not reach the fixture hold within 10 seconds.'));
      }, 10_000);
      entry = {
        matches,
        resolve(value) { clearTimeout(timer); resolve(value); },
        cancel() { clearTimeout(timer); reject(new Error('The fixture closed before the held API response arrived.')); },
      };
      heldResponses.push(entry);
    });
    void pending.catch(() => {});
    return pending;
  };
  const networkListener = ({ data }) => {
    try {
      const message = JSON.parse(String(data));
      if (message.method === 'Network.loadingFailed') onNetworkFailure(message.params);
    } catch (error) {
      failureCount += 1;
      if (failures.length < 20) failures.push({ error: safeProtocolError(error), request: null });
    }
  };
  const listener = ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); }
    catch (error) {
      failureCount += 1;
      if (failures.length < 20) failures.push({ error: safeProtocolError(error), request: null });
      return;
    }
    if (message.method !== 'Fetch.requestPaused') return;
    tasks.push((async () => {
      let record;
      try {
        const { requestId, networkId, resourceType, request: asked } = message.params;
        record = {
          fetchRequestId: String(requestId),
          networkId: networkId ? String(networkId) : null,
          resourceType: String(resourceType ?? '').slice(0, 40),
          address: {
            ...safeRequestAddress(asked.url),
            fixtureCancelProbe: new URL(asked.url).search === '?fixture_cancel=1',
          },
          method: String(asked.method ?? '').slice(0, 16),
          stage: 'paused',
          completionAttempts: 0,
          completion: null,
          completed: false,
          responseStatus: null,
          bodyCompleted: false,
          bodyBytes: 0,
          bodyBytesCapped: false,
          timing: stopping ? 'during-stop' : 'active',
          stopObserved: false,
          networkFailure: null,
        };
        interceptions.push(record);
        if (record.networkId) {
          const attached = byNetworkRequest.get(record.networkId) ?? [];
          attached.push(record);
          byNetworkRequest.set(record.networkId, attached);
          const earlier = earlyNetworkFailures.get(record.networkId);
          if (earlier?.length) {
            record.networkFailure = earlier.at(-1);
            record.networkFailureTiming = record.networkFailure.timing;
            if (record.networkFailure.canceled) markObservedAbort(record);
            for (const check of networkFailureWaiters) check();
          }
        }
        const address = new URL(asked.url);
        const base = address.origin === JOURNEY_HOSTED ? site.base
          : [JOURNEY_LOCAL, view.base].includes(address.origin) ? view.base : null;
        if (!base) {
          record.stage = 'reject-foreign-origin';
          await completePausedRequest(record, 'Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
          return;
        }
        const accept = Object.entries(asked.headers).find(([name]) => name.toLowerCase() === 'accept')?.[1] || '';
        if (liveStreams && asked.method === 'GET' && address.pathname.startsWith('/api/')
          && (address.pathname.endsWith('/events') || String(accept).includes('text/event-stream'))) {
          // A finite fulfilled first chunk is EOF, not a live stream: it creates artificial reconnect traffic.
          // Keep the real stream open through the owned HTTP proxy, as the accepted exit journey does.
          record.liveStream = true;
          await completePausedRequest(record, 'Fetch.continueRequest', {
            requestId, url: base + address.pathname + address.search,
            headers: Object.entries(asked.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase()))
              .map(([name, value]) => ({ name, value })),
          });
          return;
        }
        record.stage = 'fetching-owned-fixture';
        record.abortController = new AbortController();
        if (record.terminalCancellation) return;
        const headers = Object.fromEntries(Object.entries(asked.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())));
        const response = await fetchLive(base + address.pathname + address.search, {
          method: asked.method, headers, redirect: 'manual',
          ...(asked.postData === undefined ? {} : { body: asked.postData }),
          signal: AbortSignal.any([record.abortController.signal, AbortSignal.timeout(10_000)]),
        });
        record.responseStatus = response.status;
        record.stage = 'reading-owned-response';
        let body;
        if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
          const reader = response.body.getReader();
          record.reader = reader;
          try {
            const first = await reader.read();
            body = Buffer.from(first.value || []);
          } finally {
            await reader.cancel();
            record.reader = null;
          }
        } else body = Buffer.from(await response.arrayBuffer());
        record.bodyBytes = Math.min(body.length, 1_000_000);
        record.bodyBytesCapped = body.length > record.bodyBytes;
        record.bodyCompleted = true;
        const heldIndex = heldResponses.findIndex((entry) => entry.matches({ method: asked.method, path: address.pathname, search: address.search, status: response.status }));
        if (heldIndex !== -1) {
          record.stage = 'holding-owned-response';
          const [held] = heldResponses.splice(heldIndex, 1);
          let release;
          const released = new Promise((resume) => {
            release = () => { releaseHeldResponses.delete(release); resume(); };
            releaseHeldResponses.add(release);
          });
          record.releaseHeldResponse = release;
          held.resolve({ status: response.status, release });
          if (record.terminalCancellation) release();
          await released;
          record.releaseHeldResponse = null;
        }
        if (record.terminalCancellation) return;
        await completePausedRequest(record, 'Fetch.fulfillRequest', {
          requestId, responseCode: response.status,
          responseHeaders: [...response.headers].filter(([name]) => !['content-length', 'connection', 'transfer-encoding', 'keep-alive', 'date'].includes(name.toLowerCase())).map(([name, value]) => ({ name, value })),
          body: body.toString('base64'),
        });
      } catch (error) {
        if (record && isConfirmedBrowserCancellation(record) && record.completionAttempts === 0
          && record.abortController?.signal.aborted && error.name === 'AbortError') {
          record.stage = 'browser-cancelled';
          return;
        }
        // CDP may deliver the canceled network event after the command rejection. Only this exact
        // owned single-fulfill error may wait for correlation; expiry or any other outcome remains fatal.
        if (record && isAbortCompletionCandidate(record) && !record.networkFailure) {
          try { await waitForNetworkFailure((entry) => entry === record); }
          catch { record.cancellationCorrelationExpired = true; }
        }
        if (record?.terminalCancellation && isObservedAbortCompletionRace(record)) {
          record.stage = 'browser-cancelled-after-completion-race';
          return;
        }
        if (record) {
          record.stage = record.stage === 'completion-command-rejected' ? record.stage : 'interception-handler-failed';
          record.failure = safeProtocolError(error);
        }
        failureCount += 1;
        if (failures.length < 20) failures.push({ error: safeProtocolError(error), request: record ? safeInterception(record) : null });
      }
    })());
  };
  chrome.socket.addEventListener('message', listener);
  chrome.socket.addEventListener('message', networkListener);
  // Chrome drops a paused request when its document is replaced, and reports no Network.loadingFailed for it (#748),
  // so a read still in flight as the fixture navigates away would be stranded unaccounted. Each hosted document
  // counts its own finite reads and can close to new ones; live streams are continued at once and stay open.
  const { identifier: fetchGate } = await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    if (location.origin !== ${JSON.stringify(JOURNEY_HOSTED)}) return;
    const nativeFetch = window.fetch.bind(window);
    const gate = { closed: false, open: 0 };
    Object.defineProperty(window, '__journeyFetchGate', { value: gate });
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const accept = new Headers(init?.headers ?? (typeof input === 'string' ? undefined : input.headers)).get('accept') || '';
      if (url.pathname.endsWith('/events') || accept.includes('text/event-stream')) return gate.closed ? new Promise(() => {}) : nativeFetch(input, init);
      if (gate.closed) return new Promise(() => {});
      gate.open += 1;
      return nativeFetch(input, init).finally(() => { gate.open -= 1; });
    };
  })()` });
  await chrome.send('Fetch.enable', { patterns: [{ urlPattern: JOURNEY_HOSTED + '/*', requestStage: 'Request' }, { urlPattern: JOURNEY_LOCAL + '/*', requestStage: 'Request' }, { urlPattern: view.base + '/*', requestStage: 'Request' }] });
  /** Close the hosted document to new reads and wait until every read it started has its answer from this fixture. */
  async function quiescePage() {
    if (!(await chrome.stable('(() => { const gate = window.__journeyFetchGate; if (gate) gate.closed = true; return Boolean(gate); })()'))) return;
    await chrome.waitFor('window.__journeyFetchGate.open === 0');
    await drainTasks();
  }
  /** Leave the hosted page for a blank one only once nothing it started is still paused here. */
  async function leavePage() {
    await quiescePage();
    await chrome.send('Page.navigate', { url: 'about:blank' });
    await chrome.waitFor('location.href === "about:blank"');
  }
  const stop = async () => {
    stopping = true;
    for (const record of interceptions) record.stopObserved = true;
    for (const held of heldResponses.splice(0)) held.cancel();
    for (const release of releaseHeldResponses) release();
    const errors = [];
    // Close the page to new reads and settle the ones it started before leaving it, so no read is stranded by the
    // navigation; anything still arriving during shutdown is drained instead of escaping to a real origin.
    try { await quiescePage(); } catch (error) { errors.push(error); }
    try { await drainTasks(); } catch (error) { errors.push(error); }
    try {
      await chrome.send('Page.navigate', { url: 'about:blank' });
      await chrome.waitFor('location.href === "about:blank"');
    } catch (error) { errors.push(error); }
    try { await drainTasks(); } catch (error) { errors.push(error); }
    try { await chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: fetchGate }); } catch (error) { errors.push(error); }
    try { await chrome.send('Fetch.disable'); } catch (error) { errors.push(error); }
    try { await drainTasks(); } catch (error) { errors.push(error); }
    finally {
      chrome.socket.removeEventListener('message', listener);
      chrome.socket.removeEventListener('message', networkListener);
    }
    if (errors.length) {
      const summaries = errors.map((error) => {
        const safe = safeProtocolError(error);
        return (typeof safe === 'string' ? safe : safe.message).slice(0, 180);
      });
      throw new AggregateError(errors, 'journey interception cleanup failed: ' + summaries.join(' | '));
    }
    const incomplete = interceptions.filter((record) => !isAccountedRequest(record));
    const diagnostic = JSON.stringify(safeTrace());
    assert.equal(failureCount, 0, 'the hosted and loopback fixture requests complete; safe interception trace: ' + diagnostic);
    assert.equal(incomplete.length, 0, 'each paused request completes once or has its own confirmed browser cancellation; safe interception trace: ' + diagnostic);
  };
  stop.cancelOwned = cancelOwned;
  stop.leavePage = leavePage;
  /** Observe terminal request outcomes after the caller releases or aborts its owned inputs. */
  stop.settled = () => Promise.allSettled(tasks);
  stop.holdNextResponse = holdNextResponse;
  stop.waitForNetworkFailure = waitForNetworkFailure;
  stop.trace = safeTrace;
  return stop;
}

test('the hosted journey owns startup resources before readiness [N26,C7]', { timeout: 5_000 }, async () => {
  const box = machine();
  const neverReady = join(box.dir, 'never-ready.js');
  writeFileSync(neverReady, 'setInterval(() => {}, 1000);\n');
  const viewAbort = new AbortController();
  const viewReason = new Error('stop the owned view before its URL');
  let stopView;
  const startingView = startView(box, { bin: neverReady, signal: viewAbort.signal, onOwned(stop) {
    stopView = stop;
    viewAbort.abort(viewReason);
  } });
  assert.equal(typeof stopView, 'function', 'the view is owned synchronously after spawn');
  try { await assert.rejects(startingView, error => error === viewReason); }
  finally { viewAbort.abort(viewReason); await stopView(); }
  assert.strictEqual(stopView(), stopView(), 'repeated view cleanup shares the same completed stop');

  const sleeper = join(box.dir, 'owned-browser-startup');
  writeFileSync(sleeper, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(sleeper, 0o700);
  const browserAbort = new AbortController();
  const browserReason = new Error('stop the owned browser before its port');
  const stops = [];
  const startingBrowser = startSnapshotChrome(sleeper, join(box.dir, 'abort-browser-profile'), {
    signal: browserAbort.signal, onOwned(stop) {
      stops.push(stop);
      browserAbort.abort(browserReason);
    },
  });
  assert.equal(stops.length, 1, 'the browser group is owned synchronously after spawn');
  try { await assert.rejects(startingBrowser, error => error === browserReason); }
  finally { browserAbort.abort(browserReason); await Promise.allSettled(stops.map(stop => stop())); }
  assert.equal(stops.length, 1, 'aborting startup never launches a retry');
  assert.strictEqual(stops[0](), stops[0](), 'repeated browser cleanup shares one completed stop');
});

test('the hosted journey names its phase and stops within its own deadline [N26,H5,C7]', { timeout: 5_000 }, async (t) => {
  const acknowledged = journeyDeferred();
  let heldResponse;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.flushHeaders();
    heldResponse = response;
    acknowledged.resolve();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const site = { base: `http://127.0.0.1:${server.address().port}` };
  const view = { base: 'http://127.0.0.1:1' };
  const chrome = {
    socket: new EventTarget(),
    async send() { return {}; },
    async stable() { return false; },
    async waitFor() { return true; },
  };
  let deadline;
  let stop;
  let stopping;
  let fallbackTimer;
  const releaseSse = () => {
    if (!heldResponse || heldResponse.destroyed || heldResponse.writableEnded) return;
    heldResponse.write('data: release\n\n');
    heldResponse.end();
  };

  try {
    stop = await interceptJourneyOrigins(chrome, site, view, { deadline: () => deadline });
    chrome.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      method: 'Fetch.requestPaused',
      params: {
        requestId: 'fixture-fetch-request',
        networkId: 'fixture-network-request',
        resourceType: 'EventSource',
        request: {
          url: `${JOURNEY_HOSTED}/api/v1/boards/${'a'.repeat(32)}/events`,
          method: 'GET',
          headers: {},
        },
      },
    }) }));

    // This handshake proves the real loopback server sent headers while withholding the first SSE body chunk.
    await acknowledged.promise;
    deadline = createJourneyDeadline({ timeoutMs: 50, onTimeout: () => stop.cancelOwned() });
    deadline.setPhase('held interception');
    deadline.setCleanupStage('stop-interception');

    // Hang ceiling only: the pre-deadline implementation eventually drains when this exact response is released.
    fallbackTimer = setTimeout(releaseSse, 250);
    stopping = stop();
    await assert.rejects(stopping, (error) => {
      const pending = [error];
      const seen = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        if (current.name === 'JourneyDeadlineExceededError'
            && current.phase === 'held interception'
            && current.cleanupStage === 'stop-interception') {
          assert.match(current.message, /phase held interception/u,
            'the deadline names the phase in its actual failure text');
          assert.match(current.message, /cleanup stage stop-interception/u,
            'the deadline names the cleanup stage in its actual failure text');
          return true;
        }
        if (Array.isArray(current.errors)) pending.push(...current.errors);
        if (current.cause) pending.push(current.cause);
      }
      return false;
    }, 'the held EventSource is attributed to its phase and the shared deadline');
  } finally {
    clearTimeout(fallbackTimer);
    releaseSse();
    if (stopping) await Promise.allSettled([stopping]);
    if (stop?.settled) await stop.settled();
    deadline?.dispose();
    if (heldResponse && !heldResponse.destroyed) heldResponse.destroy();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  const ordinary = new Error('the owned fixture rejected before its deadline');
  const ordinaryDeadline = createJourneyDeadline({ timeoutMs: 1_000, onTimeout() {} });
  try {
    await assert.rejects(drainJourneyTasks([Promise.reject(ordinary)], ordinaryDeadline),
      error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === ordinary,
      'an ordinary request failure retains its original error instead of becoming a timeout');
  } finally { ordinaryDeadline.dispose(); }
});

/** A fixture handshake and release, independent of elapsed-time guesses. */
function journeyDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('the hosted page lists linked and local boards together [N26,H5]', {
  timeout: relayWorkBudgetMs() * 4 + 60_000,
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async (t) => {
  const executable = findChromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the hosted mixed-board proof.');
  const journeyStartedAt = performance.now();
  let journeyPhase = 'setup-linked-relay-board';
  let journeyCleanupStage = 'test-body-cleanup-not-reached';
  let journeySucceeded = false;
  let journeyFailureDiagnosticEmitted = false;
  let journeyAbortDiagnosticEmitted = false;
  let journeyTrace = () => null;
  const journeyActionTrace = [];
  /** Emit one bounded event without exposing error messages, request URLs, or credentials. */
  const emitJourneyDiagnostic = (event, error = null, priorBodyError = null) => {
    let interception = null;
    try { interception = journeyTrace(); } catch { interception = { unavailable: true }; }
    /** Keep only bounded error identifiers; messages may contain fixture secrets. */
    const safeError = (value) => {
      if (!value) return null;
      const name = /^[A-Za-z][A-Za-z0-9_$.-]{0,79}$/u.test(String(value.name ?? '')) ? String(value.name) : null;
      const code = /^[A-Z0-9_]{1,64}$/u.test(String(value.code ?? '')) ? String(value.code) : null;
      return { name, code };
    };
    const record = { kind: 'hosted-local-journey-diagnostic', event, phase: journeyPhase,
      elapsedMs: Math.round(performance.now() - journeyStartedAt), cleanupStage: journeyCleanupStage,
      error: safeError(error), priorBodyError: safeError(priorBodyError), actionTrace: journeyActionTrace, interception };
    try { process.stderr.write('[hosted-local-journey] ' + JSON.stringify(record) + '\n'); } catch { /* Diagnostics must not replace the test failure. */ }
  };
  /** Report abort independently so a prior body-failure event cannot hide the cleanup stage. */
  const onJourneyAbort = () => {
    if (journeyAbortDiagnosticEmitted) return;
    journeyAbortDiagnosticEmitted = true;
    emitJourneyDiagnostic('test-signal-aborted', t.signal.reason, journeyBodyError ?? null);
    void cancelJourneyOwned(t.signal.reason);
  };
  let journeyBodyError;
  const journeyAbortController = new AbortController();
  const ownedStartupStops = new Set();
  /** Register a closer before resource startup yields; late startup cannot escape ownership. */
  const registerOwnedStartup = (stop) => { ownedStartupStops.add(stop); };
  let cancelJourneyOwned = (reason) => journeyAbortController.abort(reason);
  const journeyDeadline = createJourneyDeadline({ timeoutMs: relayWorkBudgetMs() * 4, onTimeout: (error) => {
    emitJourneyDiagnostic('own-deadline', error);
    return cancelJourneyOwned(error);
  } });
  let activeJourneyDeadline = journeyDeadline;
  journeyDeadline.setPhase(journeyPhase);
  t.signal.addEventListener('abort', onJourneyAbort, { once: true });
  t.after(() => {
    t.signal.removeEventListener('abort', onJourneyAbort);
    journeyDeadline.dispose();
    activeJourneyDeadline.dispose();
    if ((!journeySucceeded || journeyCleanupStage !== 'cleanup-complete') && !journeyFailureDiagnosticEmitted) {
      journeyFailureDiagnosticEmitted = true;
      emitJourneyDiagnostic('test-ended-before-success', journeyBodyError ?? null);
    }
  });
  const linked = await journeyDeadline.wait('set up linked board', () => relayClientFixture(t));
  const linkedId = linked.before.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;
  const remoteTitle = 'linked machine A keeps its relay board';
  assert.equal((await journeyDeadline.wait('create linked item', () => linked.cli('add', linked.lane, remoteTitle))).code, 0, 'machine A creates a real relay fixture item');
  await journeyDeadline.wait('link first board', () => linked.link());
  const linkedKey = readFileSync(linked.keyFile, 'utf8').trim();

  journeyPhase = 'setup-local-project-fixtures';
  journeyDeadline.setPhase(journeyPhase);
  const local = machine();
  const localProject = project(local, 'local-machine-b');
  const localTitle = 'local machine B keeps its own view board';
  local.run(localProject.repo, 'add', 'web', localTitle);
  const duplicateProject = project(local, 'local-machine-c');
  const duplicateTitle = 'local machine C keeps its own view board';
  local.git(duplicateProject.repo, 'remote', 'add', 'origin', 'git@github.com:fixture/repository-2.git'); // one team board per repository [E12]
  local.run(duplicateProject.repo, 'add', 'web', duplicateTitle);
  journeyPhase = 'setup-local-relay-board';
  journeyDeadline.setPhase(journeyPhase);
  const localRelayEnv = {
    ...linked.env,
    HOME: local.dir,
    PULLBOARD_HOME: local.env.PULLBOARD_HOME,
    PULLBOARD_MACHINE_HOME: local.env.PULLBOARD_MACHINE_HOME,
    PATH: local.env.PATH,
  };
  const localRelayResult = await journeyDeadline.wait('link duplicate board', () => runFixtureChildAsync(process.execPath,
    [BIN, 'relay', 'on', '--url', linked.origin, '--json'],
    { cwd: duplicateProject.repo, env: localRelayEnv, timeout: relayWorkBudgetMs(), signal: journeyAbortController.signal }));
  assert.equal(localRelayResult.status, 0,
    'C links its actual local board to the relay as a second source for the same board identity');
  const localRelay = JSON.parse(readFileSync(join(duplicateProject.repo, '.git', 'pullboard', 'relay.json'), 'utf8'));
  const localRelayKey = readFileSync(join(local.env.PULLBOARD_HOME, 'relay-keys', localRelay.board + '.key'), 'utf8').trim();
  assert.notEqual(localRelay.board, linkedId, 'the linked C board is distinct from A');
  journeyPhase = 'start-view-browser-and-interception';
  journeyDeadline.setPhase(journeyPhase);
  const profile = join(linked.root, 'mixed-board-chrome');
  let localView;
  let site;
  let chrome;
  let ownedChrome;
  let closingChrome;
  let stopOrigins;
  const heldMoves = [];
  // The move's own reply is the act's outcome (#748): every relay read the following refresh makes waits here, so an
  // act that still waited on that whole-page refresh would never complete while they are held.
  const holdRelayReads = "(() => { const read = transport.request; window.__relayReadsHeld = []; window.__releaseRelayReads = () => { transport.request = read; for (const go of window.__relayReadsHeld.splice(0)) go(); }; transport.request = (path, body) => new Promise((resolve, reject) => window.__relayReadsHeld.push(() => read.call(transport, path, body).then(resolve, reject))); return true; })()";
  const releaseRelayReads = '(() => { window.__releaseRelayReads(); return true; })()';
  /** Read only the fixture's existing bounded, redacted interception trace. */
  journeyTrace = () => stopOrigins?.trace?.() ?? null;
  /** Close only this fixture's browser and reads; racing a promise never claims cancellation. */
  cancelJourneyOwned = (reason) => {
    journeyAbortController.abort(reason);
    const settling = [...ownedStartupStops].map((stop) => Promise.resolve().then(stop));
    if (stopOrigins) settling.push(stopOrigins.cancelOwned(reason));
    if (ownedChrome) {
      closingChrome ??= closeSnapshotChrome(ownedChrome);
      settling.push(closingChrome);
    }
    return Promise.allSettled(settling);
  };
  const safeJourneyError = (error) => {
    const message = String(error?.message ?? error ?? 'unknown error');
    return /^[A-Za-z0-9 _.:/-]{1,180}$/u.test(message) ? message : '<redacted error>';
  };
  try {
    localView = await journeyDeadline.wait('start local view', () => startView(local, { signal: journeyAbortController.signal, onOwned: registerOwnedStartup }));
    site = await journeyDeadline.wait('start hosted fixture', async () => {
      const started = await journeyRelaySite(linked, localView.base);
      // Listening is asynchronous too: dispose a late handoff if the caller already timed out.
      if (journeyAbortController.signal.aborted) {
        started.server.closeAllConnections();
        await new Promise((done) => started.server.close(done));
        throw journeyAbortController.signal.reason;
      }
      return started;
    });
    ownedChrome = await journeyDeadline.wait('start owned browser', () => openSnapshotChrome(executable, 'about:blank', profile, { signal: journeyAbortController.signal, onOwned: registerOwnedStartup }));
    chrome = new Proxy(ownedChrome, {
      /** Bound each browser call while keeping its real implementation and arguments unchanged. */
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args) => activeJourneyDeadline.wait(`browser ${String(key)}`, () => value.apply(target, args));
      },
    });
    stopOrigins = await interceptJourneyOrigins(chrome, site, localView, { deadline: () => activeJourneyDeadline, liveStreams: true });
    // Observe only fixed action-stage labels; no page values, request bodies or credentials enter diagnostics.
    const actionStages = new Set(['api-started', 'api-parsed', 'api-rejected', 'act-started', 'act-completed', 'act-rejected']);
    const actionListener = ({ data }) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.method !== 'Runtime.consoleAPICalled') return;
      const value = message.params?.args?.[0]?.value;
      if (typeof value !== 'string' || !value.startsWith('[held-local-action] ')) return;
      const stage = value.slice('[held-local-action] '.length);
      if (!actionStages.has(stage)) return;
      journeyActionTrace.push({ stage, phase: journeyPhase });
      if (journeyActionTrace.length > 16) journeyActionTrace.shift();
    };
    chrome.socket.addEventListener('message', actionListener);
    t.after(() => chrome.socket.removeEventListener('message', actionListener));
    const session = await journeyDeadline.wait('authenticate private browser', () => linked.phoneSession());
    assert.equal((await chrome.send('Network.setCookie', {
      name: 'pb_session', value: session.token, url: JOURNEY_HOSTED, httpOnly: true, sameSite: 'Lax',
    })).success, true, 'the fixture person session is installed only in this private browser');
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: JOURNEY_HOSTED, permissions }); break; } catch { /* Chrome versions expose different local-network permission names. */ }
    }

    journeyPhase = 'pair-linked-board-and-consume-key';
    journeyDeadline.setPhase(journeyPhase);
    // Pair the real board key in the fragment; the relay client consumes it into device storage before local discovery.
    await chrome.send('Page.navigate', { url: JOURNEY_HOSTED + '/#board=' + linkedId + '&key=' + encodeURIComponent(linkedKey) });
    await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(remoteTitle) + ')', 30_000); // budget: 30s hang ceiling for the real linked-board read under load.
    await chrome.waitFor('location.hash === ""', 10_000); // budget: 10s hang ceiling for relay-fragment consumption after the board renders.

    journeyPhase = 'pair-duplicate-board';
    journeyDeadline.setPhase(journeyPhase);
    // C's real local board is also paired on the relay so this catches duplicate-ID source preference.
    // Start a fresh hosted document before pairing C, then wait for transport work rather than assuming C is selected.
    await stopOrigins.leavePage();
    await chrome.send('Page.navigate', { url: JOURNEY_HOSTED + '/#board=' + localRelay.board + '&key=' + encodeURIComponent(localRelayKey) });
    await chrome.waitFor('location.hash === "" && !!JSON.parse(localStorage.getItem("pullboard.relay.keys.v1") || "{}")[' + JSON.stringify(localRelay.board) + ']', 30_000); // budget: 30s hang ceiling for paired-key storage to settle.
    assert.ok(linked.calls.some(call => call.method === 'GET'
      && call.path === '/api/v1/boards/' + localRelay.board + '/state' && call.browser),
    'C’s private pairing key was consumed and its real snapshot was read by the authenticated browser');

    journeyPhase = 'discover-combined-board-list';
    journeyDeadline.setPhase(journeyPhase);
    // The hosted page's real local-view handoff discovers B without a pasted key, URL or port.
    await stopOrigins.leavePage();
    await chrome.send('Page.navigate', { url: JOURNEY_HOSTED + '/' });
    await chrome.waitFor("[...document.querySelectorAll('#proj-list .proj.repo')].some(row => row.textContent.includes('fixture/repository')) && [...document.querySelectorAll('#proj-list .proj.repo')].some(row => row.textContent.includes('local-machine-b')) && [...document.querySelectorAll('#proj-list .proj.repo')].some(row => row.textContent.includes('local-machine-c'))");
    const localList = await (await fetchLive(localView.base + '/api/v1/boards', { headers: { 'x-pullboard-key': localView.key } })).json();
    const localId = localList.boards.find((board) => board.name === 'local-machine-b').id;
    const duplicateId = localList.boards.find((board) => board.name === 'local-machine-c').id;
    assert.equal(duplicateId, localRelay.board, 'C has one real board identity at both sources');
    const localOrigin = await chrome.stable('localSession?.origin || null');
    assert.equal(localOrigin, localView.base, 'the page keeps the ephemeral local origin from its real handoff');
    const rows = JSON.parse(await chrome.stable('JSON.stringify({ projects: data.projects.map(({id,name,root,source}) => ({id,name,root: source === \"relay\" ? \"relay\" : \"local\",source})), labels: [...document.querySelectorAll(\"#proj-list .proj.repo .pname\")].map(node => node.textContent), secretInAddress: /key=|pullboard-local=/.test(location.href) })'));
    assert.deepEqual(rows.labels.sort(), ['fixture/repository', 'local-machine-b', 'local-machine-c'], 'the page shows unlinked B and linked C locally beside A from the relay');
    assert.deepEqual(rows.projects.map((row) => row.id).sort(), [linkedId, localId, duplicateId].sort(), 'the hosted view keeps A, B and C identities');
    assert.equal(rows.projects.find((row) => row.id === linkedId).root, 'relay', 'a remote board uses an opaque root, not A’s filesystem path');
    assert.equal(rows.projects.find((row) => row.id === localId).source, 'local', 'unlinked B remains a local board');
    assert.equal(rows.projects.find((row) => row.id === duplicateId).source, 'local', 'C wins when its actual identity is present through both sources');
    assert.equal(rows.secretInAddress, false, 'the hosted page removes pairing and local-session fragments');
    assert.equal(rows.projects.filter((row) => row.id === duplicateId).length, 1, 'the duplicate local/relay identity appears once in the composed list');

    journeyPhase = 'exercise-local-and-relay-reads';
    journeyDeadline.setPhase(journeyPhase);
    const localRow = "Array.from(document.querySelectorAll('#proj-list .proj.repo')).find(row => row.textContent.includes('local-machine-b'))";
    await pickProject(chrome, localRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b').root && document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(localTitle) + ") && !readOnly && !requests");
    const abortedPath = '/api/v1/boards/' + localId + '/state';
    const heldAbort = stopOrigins.holdNextResponse(({ method, path, search }) =>
      method === 'GET' && path === abortedPath && search === '?fixture_cancel=1');
    assert.equal(await chrome.stable(`(async () => {
      window.__journeyAbortController = new AbortController();
      window.__journeyAbortResult = null;
      window.__journeyAbortPromise = fetch(localReadBase + ${JSON.stringify(abortedPath + '?fixture_cancel=1')}, {
        headers: localReadHeaders, cache: 'no-store', signal: window.__journeyAbortController.signal,
      }).then(response => { window.__journeyAbortResult = { status: response.status }; return response.status; })
        .catch(error => { window.__journeyAbortResult = { name: error.name }; return error.name; });
      return 'started';
    })()`), 'started');
    const heldAbortResponse = await heldAbort;
    assert.equal(heldAbortResponse.status, 200, 'the real local API completed before its browser response was held');
    assert.deepEqual(await chrome.stable(`(async () => {
      window.__journeyAbortController.abort();
      await window.__journeyAbortPromise;
      return window.__journeyAbortResult;
    })()`), { name: 'AbortError' }, 'the page reports the actual browser fetch abort');
    const canceledInterception = await stopOrigins.waitForNetworkFailure((record) =>
      record.method === 'GET' && record.address.fixtureCancelProbe && record.networkFailure?.canceled === true);
    assert.equal(canceledInterception.networkFailure.canceled, true,
      'browser cancellation is correlated to this exact paused local-state request');
    heldAbortResponse.release();
    const duplicateRow = "Array.from(document.querySelectorAll('#proj-list .proj.repo')).find(row => row.textContent.includes('local-machine-c'))";
    await pickProject(chrome, duplicateRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(duplicateId) + ").root && document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(duplicateTitle) + ") && !readOnly && !requests");
    const remoteRow = "Array.from(document.querySelectorAll('#proj-list .proj.repo')).find(row => row.textContent.includes('fixture/repository'))";
    // Queue the call while a writable local board is selected, then release it only after the real
    // relay mapping and selected board settle. The late call must take the relay-board refusal.
    const lateMovePath = '/api/v1/boards/' + linkedId + '/moves';
    const lateMoveBody = { verb: 'shout', args: { to: 'coordinator', text: 'late relay writes stay refused' } };
    assert.equal(await chrome.stable(`(() => { window.__lateRelayMove = () => api(${JSON.stringify(lateMovePath)}, ${JSON.stringify(lateMoveBody)}); return !readOnly && !requests; })()`), true,
      'the late relay call is queued while the local board is writable');
    await pickProject(chrome, remoteRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(linkedId) + ").root && readOnly && requests");
    assert.equal(await chrome.stable(`boardSources.get(${JSON.stringify(linkedId)})?.kind`), 'relay',
      'the delayed call resolves to the actual linked relay board, without replacing its source');
    const relayWritesBefore = linked.calls.filter(call => call.method === 'POST' && call.path === lateMovePath).length;
    const lateRefusal = await chrome.stable(`(async () => { const release = window.__lateRelayMove; delete window.__lateRelayMove; try { await release(); return 'unexpected success'; } catch (error) { return error.message; } })()`);
    assert.match(lateRefusal, /read-only view/i, 'the late relay-board branch keeps the established read-only refusal');
    assert.equal(linked.calls.filter(call => call.method === 'POST' && call.path === lateMovePath).length, relayWritesBefore,
      'the late refused write never reaches the actual relay server');

    assert.ok(linked.calls.some((call) => call.method === 'GET' && call.path === '/api/v1/boards/' + linkedId + '/state'),
      'the relay board state is read through its relay transport');
    assert.ok(linked.calls.some((call) => call.method === 'GET' && call.path.startsWith('/api/v1/boards/' + linkedId + '/events')),
      'the relay board events use the relay client stream');
    const localReads = chrome.requests.filter((entry) => entry.url.startsWith(localOrigin + '/api/v1/boards/'));
    assert.ok(localReads.some((entry) => new URL(entry.url).pathname === '/api/v1/boards/' + localId + '/state'),
      'B board state is read through B’s local view');
    assert.ok(localReads.some((entry) => new URL(entry.url).pathname === '/api/v1/boards/' + localId + '/events'),
      'B board events use B’s local view stream');
    assert.ok(localReads.some((entry) => new URL(entry.url).pathname === '/api/v1/boards/' + duplicateId + '/state'),
      'C board state uses C’s local view despite its paired relay copy');
    assert.ok(localReads.some((entry) => new URL(entry.url).pathname === '/api/v1/boards/' + duplicateId + '/events'),
      'C board events use C’s local view despite its paired relay copy');
    assert.equal(localReads.some((entry) => new URL(entry.url).pathname.includes(linkedId)), false,
      'the local view never receives A’s relay board id');

    journeyPhase = 'hold-local-completion-across-board-switch';
    journeyDeadline.setPhase(journeyPhase);
    // Hold only delivery of a real local API response after the write has completed. Switching to a relay board
    // while it is in flight must not reinterpret the local response as a sealed request or clear that board's form.
    await pickProject(chrome, localRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b').root && !readOnly && !requests");
    await chrome.stable(`(() => {
      const stage = value => console.info('[held-local-action] ' + value);
      const priorApi = api;
      api = async (path, body) => {
        const tracked = body && path === ${JSON.stringify('/api/v1/boards/' + localId + '/moves')};
        if (tracked) stage('api-started');
        try {
          const result = await priorApi(path, body);
          if (tracked) stage('api-parsed');
          return result;
        } catch (error) {
          if (tracked) stage('api-rejected');
          throw error;
        }
      };
      window.__priorAct = act;
      window.__actOutcome = null;
      act = async (...args) => {
        stage('act-started');
        try {
          const result = await window.__priorAct(...args);
          window.__actOutcome = result;
          stage('act-completed');
          return result;
        } catch (error) { stage('act-rejected'); throw error; }
      };
      return true;
    })()`);
    await chrome.click("document.querySelector('#new-item')");
    await chrome.stable("document.querySelector('#add-title').value = 'held local action'; true");
    const firstHeld = stopOrigins.holdNextResponse(({ method, path }) => method === 'POST' && path === '/api/v1/boards/' + localId + '/moves');
    await chrome.stable("document.querySelector('#add-title').value = 'held local action'; document.querySelector('#add-form').requestSubmit(); true");
    const firstResponse = await firstHeld;
    heldMoves.push(firstResponse.release);
    assert.ok(firstResponse.status >= 200 && firstResponse.status < 300, 'the local board accepted the real move before response delivery was held');
    await pickProject(chrome, remoteRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(linkedId) + ").root && readOnly && requests");
    await chrome.click("document.querySelector('#new-item')");
    await chrome.stable("document.querySelector('#add-title').value = 'relay draft survives local completion'; true");
    assert.equal(await chrome.stable(holdRelayReads), true, 'relay reads wait for the fixture');
    firstResponse.release();
    await chrome.waitFor('window.__actOutcome !== null');
    assert.equal(await chrome.stable('window.__actOutcome'), true, 'a local write response is parsed using the mode it started with after switching to relay');
    assert.equal(await chrome.stable("document.querySelector('#add-title').value"), 'relay draft survives local completion', 'the older local completion does not clear the current relay draft');
    assert.equal(await chrome.stable(releaseRelayReads), true, 'the held relay reads go on');

    journeyPhase = 'hold-second-local-completion-across-reselection';
    journeyDeadline.setPhase(journeyPhase);
    // Switching away and back can leave the same root selected. A successful old submit must still preserve a new
    // draft entered in that board's form while the response was held.
    await pickProject(chrome, localRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b').root && !readOnly && !requests");
    await chrome.click("document.querySelector('#new-item')");
    await chrome.stable("document.querySelector('#add-title').value = 'second held local action'; true");
    const secondHeld = stopOrigins.holdNextResponse(({ method, path }) => method === 'POST' && path === '/api/v1/boards/' + localId + '/moves');
    await chrome.stable('window.__actOutcome = null; true');
    await chrome.stable("document.querySelector('#add-form').requestSubmit(); true");
    const secondResponse = await secondHeld;
    heldMoves.push(secondResponse.release);
    assert.ok(secondResponse.status >= 200 && secondResponse.status < 300, 'the second real local write completes before delivery');
    await pickProject(chrome, remoteRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(linkedId) + ").root && readOnly && requests");
    await pickProject(chrome, localRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b').root && !readOnly && !requests");
    await chrome.click("document.querySelector('#new-item')");
    await chrome.stable("document.querySelector('#add-title').value = 'replacement local draft'; true");
    assert.equal(await chrome.stable(holdRelayReads), true, 'relay reads wait for the fixture');
    secondResponse.release();
    await chrome.waitFor('window.__actOutcome !== null');
    assert.equal(await chrome.stable('window.__actOutcome'), true, 'the second local write completes on its own reply');
    assert.equal(await chrome.stable("document.querySelector('#add-title').value"), 'replacement local draft', 'a completion after switching away and back preserves the replacement draft');
    assert.equal(await chrome.stable(releaseRelayReads), true, 'the held relay reads go on');

    journeyPhase = 'assert-final-browser-state';
    journeyDeadline.setPhase(journeyPhase);
    assert.deepEqual(chrome.exceptions, [], 'the hosted mixed-board page reports no uncaught browser exceptions');
    journeySucceeded = true;
  } catch (error) {
    journeyBodyError = error;
    if (!journeyFailureDiagnosticEmitted) {
      journeyFailureDiagnosticEmitted = true;
      emitJourneyDiagnostic('ordinary-failure', error);
    }
    throw error;
  } finally {
    journeyDeadline.dispose();
    // Split the existing sixty-second outer reserve: half for explicit cleanup, half for registered after-hooks and scheduling.
    activeJourneyDeadline = createJourneyDeadline({ timeoutMs: 60_000 / 2, onTimeout: (error) => {
      emitJourneyDiagnostic('cleanup-deadline', error, journeyBodyError ?? null);
      return cancelJourneyOwned(error);
    } });
    activeJourneyDeadline.setPhase(journeyPhase);
    journeyCleanupStage = 'release-held-responses';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    for (const release of heldMoves) release();
    const journeyCleanupErrors = [];
    journeyCleanupStage = 'stop-interception';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try { if (stopOrigins) await stopOrigins(); } catch (error) { journeyCleanupErrors.push(error); }
    journeyCleanupStage = 'close-browser';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try { if (ownedChrome) await (closingChrome ??= closeSnapshotChrome(ownedChrome)); } catch (error) { journeyCleanupErrors.push(error); }
    journeyCleanupStage = 'stop-local-view';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try { if (localView) await localView.stop(); } catch (error) { journeyCleanupErrors.push(error); }
    journeyCleanupStage = 'close-hosted-fixture-server';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try {
      if (site?.server) {
        site.server.closeAllConnections();
        if (site.server.listening) await new Promise((done, reject) => site.server.close((error) => error ? reject(error) : done()));
      }
    } catch (error) { journeyCleanupErrors.push(error); }
    journeyCleanupStage = 'remove-browser-profile';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try { rmSync(profile, { recursive: true, force: true }); } catch (error) { journeyCleanupErrors.push(error); }
    if (!journeyBodyError && !journeyCleanupErrors.length) {
      const trace = stopOrigins.trace();
      t.diagnostic(JSON.stringify({ kind: 'owned-browser-cancellation-proof', actionTrace: journeyActionTrace, requestCount: trace.requestCount, liveStreamCount: trace.liveStreamCount, failureCount: trace.failureCount,
        incompleteCount: trace.incompleteCount, confirmedBrowserCancellationCount: trace.confirmedBrowserCancellationCount,
        probe: trace.requests.find((record) => record.fixtureCancelProbe) }));
    }
    if (journeyCleanupErrors.length && !journeyFailureDiagnosticEmitted) {
      journeyCleanupStage = 'cleanup-failed';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
      journeyFailureDiagnosticEmitted = true;
      emitJourneyDiagnostic('cleanup-failure', journeyCleanupErrors[0]);
    }
    if (!journeyBodyError && !journeyCleanupErrors.length) journeyCleanupStage = 'cleanup-complete';
    if (journeyCleanupErrors.length) {
      t.diagnostic(JSON.stringify({
        testBodyCompletedSuccessfully: !journeyBodyError,
        testBodyFailure: journeyBodyError ? { name: journeyBodyError.name, code: journeyBodyError.code ?? null,
          stackFrames: String(journeyBodyError.stack ?? '').split('\n').filter((line) => /^\s+at\s/u.test(line)).slice(0, 6) } : null,
        cleanupFailureCount: journeyCleanupErrors.length,
        cleanupFailures: journeyCleanupErrors.slice(0, 8).map(safeJourneyError),
        interception: stopOrigins?.trace?.() ?? null,
      }));
      const failures = journeyBodyError ? [journeyBodyError, ...journeyCleanupErrors] : journeyCleanupErrors;
      throw new AggregateError(failures, 'hosted mixed-board test and/or cleanup failed: ' + failures.slice(0, 8).map(safeJourneyError).join(' | '));
    }
  }
});

test('the star line shows once to a signed-in person and stays dismissed [N26]', { timeout: 120_000 }, async (t) => { // budget: hang-only ceiling for real Chrome startup and nine page loads.
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the star line proof.');
  const star = await starLineFixture();
  const linkedBoard = { id: star.board.id, name: 'person/star-line', repository: 'person/star-line' };
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-star-line-chrome-'));
  const expected = { text: STAR_TEXT + '×', href: starRepository(), lines: 1, parts: 2, count: 1 };
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: star.script });
    // Each account read the star line makes itself. Once the page has read the account, a read from the line reaches
    // fetch inside the line's own call, so its stack names starLine (#817).
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: "(() => { const fetchNow = window.fetch.bind(window); window.__starReads = 0; window.fetch = (input, init) => { const address = new URL(String(typeof input === 'string' ? input : input.url), location.href); if (address.origin === location.origin && address.pathname === '/api/v1/boards' && /starLine/.test(new Error().stack || '')) window.__starReads += 1; return fetchNow(input, init); }; })()" });
    const page = starSteps(chrome, star);
    star.state.account = [linkedBoard]; // Even a linked list that answered a signed-out page would show nothing there.
    await chrome.send('Page.navigate', { url: star.origin + '/out' }).then(() => chrome.waitFor("location.pathname === '/out' && !document.querySelector('#local-note').hidden"));
    assert.equal(await page.shown(), null, 'a signed-out page shows no star line');
    assert.equal(star.requests.get('/api/v1/boards'), undefined, 'a signed-out page never asks for the linked list');
    await chrome.send('Page.navigate', { url: star.live.link.href }).then(() => chrome.waitFor('!!data?.project'));
    assert.equal(await chrome.stable("document.querySelector('#star-line') === null && !document.body.textContent.includes('GitHub star')"), true, 'the local view never carries the star line');
    for (const file of ['src/cli.js', 'src/mcp.js', 'src/help.js']) assert.ok(!readFileSync(new URL('../../' + file, import.meta.url), 'utf8').includes('GitHub star'), file + ' never prints the star line');
    // The account read is refused while this machine's view still answers: the refusal answers the line too, "not
    // linked", and the line never asks again on its own (#817).
    star.state.refused = true;
    await page.open('/in-local', 'no', []);
    assert.ok(star.requests.get('/api/v1/boards') >= 1, 'the page read the account and was refused');
    assert.equal(await page.shown(), null, 'a refused account read shows no star line');
    assert.equal(await chrome.stable('window.__starReads'), 0, 'and the line makes no read of its own after the refusal');
    star.state.refused = false;
    await page.open('/in-local', 'no', []);
    assert.equal(await page.shown(), null, 'a signed-in person with an unlinked local-only board sees no star line');
    await page.open('/in', 'no');
    assert.equal(await page.shown(), null, 'a signed-in person with an empty linked list sees no star line');
    await page.open('/in-local', 'yes', [linkedBoard]); // The person links this machine's board: the page reads it locally.
    assert.deepEqual(await page.shown(), expected, 'a linked board read locally shows one line, one plain sentence, linking to the repository');
    assert.equal(await chrome.stable('window.__starReads'), 0, 'the line learns from the read of the account the page already made, and makes no extra read of its own');
    assert.equal(star.requests.get('/star-transport.js'), undefined, 'no relay client loads while every linked board is local');
    for (const width of [1280, 390]) await proofShot(chrome, 'star-line', width);
    await page.dismiss();
    await page.reload('yes');
    assert.equal(await page.shown(), null, 'a dismissed star line stays dismissed across a reload, with the linked board listed');
    await chrome.stable("localStorage.removeItem('pb.star')");
    await page.open('/in', 'no', []);
    Object.assign(star.state, { account: [linkedBoard], relay: true }); // A board linked from another machine arrives through the relay.
    await chrome.waitFor(`${STAR_SHOWN} !== null`);
    assert.deepEqual(await page.shown(), expected, 'a relay-drawn linked board shows the same one line');
    await page.dismiss();
    await page.reload('yes');
    assert.equal(await page.shown(), null, 'dismissed there too, it stays dismissed across a reload');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await star.close().finally(() => rmSync(profile, { recursive: true, force: true }));
  }
});


test('the view links every board on this machine in one sign-in [H5,N26]', {
  timeout: relayWorkBudgetMs() * 12,
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async (t) => {
  for (const mode of ['linked', 'declined', 'closed', 'partial']) {
    await t.test(mode, async (scenario) => {
      const box = await relayClientFixture(scenario);
      box.providerState.deviceAuthorized = false;
      const module = (name) => new URL('../../src/' + name, import.meta.url).href;
      const fixtureModule = new URL('../fixture-child.js', import.meta.url).href;
      const prepared = await box.script(`
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { main } from ${JSON.stringify(module('cli.js'))};
import { updateRelayMachine } from ${JSON.stringify(module('relay-machine.js'))};
import { runFixtureGit } from ${JSON.stringify(fixtureModule)};
const other = join(dirname(${JSON.stringify(box.root)}), 'second-view-board');
mkdirSync(other);
for (const args of [['init','-q','-b','main'], ['-c','commit.gpgsign=false','commit','--allow-empty','-q','-m','chore: private view board']])
  runFixtureGit(args, {cwd:other,env:process.env});
if (${JSON.stringify(mode)} !== 'partial') runFixtureGit(['remote','add','origin','git@github.com:fixture/repository-2.git'], {cwd:other,env:process.env});
assert.equal(await main(['init','--json'], {cwd:other,stdin:process.stdin,stdout:{isTTY:false,write(){}},stderr:{write(){}}}),0);
updateRelayMachine(state => { state.owner = {account:'7',url:${JSON.stringify(box.origin)}}; });
process.stdout.write(JSON.stringify({other}));
`);
      assert.equal(prepared.code, 0, 'two private boards are registered through the real CLI');
      const links = [box.root, prepared.document.other].map(root => join(root, '.git/pullboard/relay.json'));
      assert.deepEqual(links.map(existsSync), [false, false]);
      let releasePoll;
      const held = new Promise(done => { releasePoll = done; });
      box.providerState.beforeDevicePoll = () => held;
      if (mode === 'declined') box.providerState.deviceDeclined = true;
      const local = await startView({dir:box.root,env:{...box.env,SSH_CONNECTION:'127.0.0.1 1 127.0.0.1 2'}}, {signal:scenario.signal});
      const chrome = await stableChrome(await startChrome());
      let cleaned = false;
      /** Close only resources owned by this scenario once, before its private relay is removed. */
      const cleanup = async () => { if (cleaned) return; cleaned = true; releasePoll?.(); await chrome.close(); await local.stop(); };
      scenario.after(cleanup);
      try {
        await chrome.navigate(local.link.href);
        await chrome.waitFor("!document.body.classList.contains('loading') && data?.projects?.length === 2");
        await chrome.stable("typeof sharingReady === 'undefined' ? null : sharingReady");
        assert.equal(await chrome.stable("document.querySelector('#share-note')?.hidden === false"), true,
          'the real local view offers one quiet invitation before any board is linked');
        assert.equal(await chrome.stable("document.querySelector('#share-note b')?.textContent"), 'Open your boards on any device');
        assert.equal(await chrome.stable("document.querySelector('#share-note .share-txt > span')?.textContent"), 'Sign in to use pullboard.dev while on the go.');
        assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify((() => { const a = document.querySelector('#share-note .share-txt a'); return a ? [a.textContent, a.href, a.target, a.rel] : null; })())")), ['How the relay works', 'https://pullboard.dev/relay/', '_blank', 'noopener']);
        const starts = box.providerCalls.filter(call => call.path === '/login/device/code').length;
        await press(chrome, "document.querySelector('#share-start')");
        // The real GitHub popup hides this tab; foreground the owned view before measuring its progress.
        await chrome.send('Page.bringToFront');
        await chrome.stable('sharingTask');
        assert.equal(box.providerCalls.filter(call => call.path === '/login/device/code').length - starts, 1,
          'one native person click starts exactly one real device sign-in for every board');
        assert.equal(await chrome.stable("document.querySelector('#share-status')?.textContent.includes('TEST-ONLY')"), true,
          'the view displays the public GitHub code');
        if (mode === 'linked') {
          await press(chrome, "document.querySelector('#share-hide')");
          assert.equal(await chrome.stable("document.querySelector('#share-again').hidden"), false,
            'dismissing while sign-in waits offers the restore entry');
        }
        if (mode === 'closed') {
          const targets = await chrome.send('Target.getTargets');
          const popup = targets.targetInfos.find(target => target.type === 'page' && target.url.endsWith('/login/device'));
          assert.ok(popup, 'the person sign-in opened in an actual browser page');
          await chrome.send('Target.closeTarget', {targetId:popup.targetId});
          await chrome.waitFor('sharing.closing === true');
          let closedState = null;
          const closed = chrome.stable('sharingTask.then(() => sharing.state)').then(state => { closedState = state; });
          const deadline = Date.now() + relayWorkBudgetMs();
          while (!box.calls.some(call => call.path === '/auth/device/cancel') && closedState === null) {
            assert.ok(Date.now() < deadline, 'closing the sign-in reaches its real cancellation request or a terminal result');
            await new Promise(done => setTimeout(done, 25));
          }
          if (closedState !== null) assert.equal(closedState, 'cancelled', 'closing waits for confirmed core cancellation');
          releasePoll();
          await closed;
          assert.equal(closedState, 'cancelled', 'closing finishes the actual core cancellation');
        } else releasePoll();
        if (mode === 'declined' || mode === 'closed') {
          await chrome.waitFor("sharing.state === 'declined' || sharing.state === 'cancelled'", relayWorkBudgetMs());
          assert.match(await chrome.stable("document.querySelector('#share-status').textContent"), /No boards were linked/u);
          assert.deepEqual(links.map(existsSync), [false, false], 'declining or closing the real sign-in links neither board');
          assert.equal(await chrome.stable("document.querySelector('#share-note').hidden"), false);
        } else {
          await chrome.waitFor("sharing.state === 'pairing' || sharing.state === 'done'", relayWorkBudgetMs() * 2);
          assert.deepEqual(links.map(existsSync), mode === 'linked' ? [true,true] : [true,false],
            'the existing core flow links each authorized registered board');
          const text = await chrome.stable("document.querySelector('#share-status').textContent");
          assert.match(text, /Linked repo/u);
          if (mode === 'linked') assert.match(text, /Linked second-view-board/u);
          else assert.match(text, /Did not link second-view-board: .+/u, 'a refused board is named with its actual reason');
          assert.equal(await chrome.stable("document.querySelector('#share-note').hidden"), true, 'the invitation disappears after linking');
          assert.equal(await chrome.stable("document.querySelector('#share-again').hidden"), true, 'linking also removes a previously dismissed restore entry');
          await press(chrome, "document.querySelector('#share-close')");
          await chrome.stable('sharingTask');
          assert.deepEqual(links.map(existsSync), mode === 'linked' ? [true,true] : [true,false], 'stopping phone pairing preserves completed board links');
        }
        assert.equal(box.providerCalls.filter(call => call.path === '/login/device/code').length - starts, 1, 'no second board sign-in or retry occurred');
        assert.doesNotMatch(await chrome.stable("document.querySelector('#share-status').textContent"), /(?:ps_|pd_|pg_|pm_)[A-Za-z0-9_-]{20,}/u,
          'the progress panel never exposes person, ticket or machine credentials');
      } finally { await cleanup(); }
    });
  }
});


test('view sign-in keeps its key and intents inside the authenticated machine view [H5,N26]', { timeout: relayWorkBudgetMs() * 3 }, async (t) => {
  const box = await relayClientFixture(t);
  box.providerState.deviceAuthorized = false;
  const serveModule = new URL('../../src/serve.js', import.meta.url).href;
  const machineModule = new URL('../../src/relay-machine.js', import.meta.url).href;
  const result = await box.script(`
import { request } from 'node:http';
import { serveView, HOSTED_ORIGIN } from ${JSON.stringify(serveModule)};
import { updateRelayMachine } from ${JSON.stringify(machineModule)};
updateRelayMachine(state => { state.owner = {account:'7',url:${JSON.stringify(box.origin)}}; });
const observations = [];
/** Return only safe HTTP observations; the outer native test makes every assertion itself. */
function observe(actual, expected, why) { observations.push({actual,expected,why}); }
const key = 'private-view-sign-in-fixture';
const view = await serveView({secret:key});
const other = await serveView({secret:key});
const scoped = await serveView({secret:key,projectRoot:${JSON.stringify(box.root)}});
/** Send one real HTTP request with explicit Host, origin and header fields. */
function call(server, {method='GET', headers={}, body, query=''}={}) {
  const address = new URL('/api/v1/view-link'+query, server.url);
  return new Promise((resolve,reject) => {
    const req = request(address, {method,headers}, res => {
      const chunks=[];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });
    req.on('error',reject);
    req.end(body);
  });
}
const auth = {'x-pullboard-key':key};
const json = {...auth,'content-type':'application/json'};
try {
  for (const options of [{}, {query:'?k='+key}, {headers:auth,query:'?intentId=anything'},
    {headers:{...auth,origin:'https://foreign.invalid'}}, {headers:{...auth,host:'foreign.invalid'}}]) {
    observe((await call(view,options)).status,403,'a sign-in route needs its own Host/origin and a header-only key');
  }
  const invitation = await call(view,{headers:auth});
  observe(invitation.status,200);
  observe(invitation.body,{version:1,available:true},'the idle invitation exposes no board paths or credentials');
  const hosted = await call(view,{headers:{...auth,origin:HOSTED_ORIGIN}});
  observe(hosted.status,200,'the trusted hosted page can use the same local person channel');
  observe(hosted.headers['access-control-allow-origin'],HOSTED_ORIGIN);
  for (const [body,type] of [['action=start','text/plain'], ['[]','application/json'],
    ['{','application/json'], [JSON.stringify({action:'run'}),'application/json'],
    [JSON.stringify({action:'start',relayUrl:'https://foreign.invalid'}),'application/json'],
    [JSON.stringify({action:'status',intentId:'not-owned'}),'application/json'],
    [JSON.stringify({action:'start',padding:'x'.repeat(5000)}),'application/json']]) {
    observe((await call(view,{method:'POST',headers:{...auth,'content-type':type},body})).status,400,'only one bounded known JSON action is admitted');
  }
  observe((await call(view,{method:'PUT',headers:json,body:'{}'})).status,405);
  observe((await call(scoped,{headers:auth})).body,{version:1,available:false});
  const scope = await call(scoped,{method:'POST',headers:json,body:JSON.stringify({action:'start'})});
  observe(scope.status,400,'a one-project view cannot authorize every board on the machine');
  observe(scope.body.error.code,'VIEW_SIGN_IN_SCOPE');
  const started = await call(view,{method:'POST',headers:json,body:JSON.stringify({action:'start'})});
  observe(started.status,200);
  observe(Object.keys(started.body).sort(),['expiresAt','intentId','userCode','verificationURL','version']);
  const intentId = started.body.intentId;
  const foreign = await call(other,{method:'POST',headers:json,body:JSON.stringify({action:'status',intentId})});
  observe(foreign.status,400,'another view cannot read an operation it did not start');
  observe(foreign.body.error?.code,'VIEW_SIGN_IN_UNKNOWN');
  const status = await call(view,{method:'POST',headers:json,body:JSON.stringify({action:'status',intentId})});
  observe(status.body.state,'waiting');
  observe(status.body.boards,[]);
  observe(/(?:ps_|pd_|pg_|pm_)[A-Za-z0-9_-]{20,}/u.test(JSON.stringify(status.body)),false,'public status contains no person, ticket or machine credential');
  const cancelled = await call(view,{method:'POST',headers:json,body:JSON.stringify({action:'cancel',intentId})});
  observe(cancelled.body.state,'cancelled');
  observe(cancelled.body.boards,[]);
  process.stdout.write(JSON.stringify({observations}));
} finally { await scoped.close(); await other.close(); await view.close(); }
`);
  assert.equal(result.code,0,'the private real-HTTP view boundary script completes');
  assert.ok(result.document.observations.length >= 20, 'the private script returned every boundary observation');
  for (const {actual,expected,why} of result.document.observations) assert.deepEqual(actual,expected,why);
  assert.equal(box.providerCalls.filter(call => call.path === '/login/device/code').length,1,
    'all refused requests and idle reads performed no sign-in; only the authenticated start did');
});
