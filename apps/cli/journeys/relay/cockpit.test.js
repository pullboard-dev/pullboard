// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request,
} from 'node:http';
import {
  delimiter,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { performance } from 'node:perf_hooks';
import { stableChrome } from '../../tests/fixtures/cockpit/stable.js';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  findChromeExecutable,
  relayWorkBudgetMs,
  startChrome,
} from '../../tests/fixtures/relay/browser.js';
import {
  BIN,
  machine,
  project,
  fetchLive,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

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
  const addedItem = await box.cli('add', 'app', itemTitle, '--route', 'mid', '--criterion', 'the local-only source exists', '--check', 'test -f src/local-only.js', '--brief', 'Files:\n- src/local-only.js\nChange:\n- add the local-only source\nTest:\n- The item check passes'); // the source checkout joined on the mid route
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
  await chrome.waitFor(`data?.project?.items?.some(item => item.title === ${JSON.stringify(itemTitle)})`);
  await chrome.click(`document.querySelector('[data-tab="items"]')`); // a person opens Items before the list is drawn, since pages open on the Dashboard.
  await chrome.waitFor(`document.querySelector('#chain')?.textContent.includes(${JSON.stringify(itemTitle)})`);
  await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
  // Shouts list conversations first; a person opens the one carrying the reference to read its messages in full.
  await chrome.waitFor(`!!document.querySelector('#feed [data-shout-thread]:not([data-shout-thread=""])') || !!document.querySelector('#feed button[data-code^="${sourceRef}:1@"]')`);
  if (await chrome.stable(`!document.querySelector('#feed button[data-code^="${sourceRef}:1@"]')`)) await chrome.click(`document.querySelector('#feed [data-shout-thread]:not([data-shout-thread=""])')`);
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
    if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(new URL("../../../view/src/io/main.css", import.meta.url)));
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
    if (req.url === '/phone/view.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(new URL('../../../view/src/io/main.css', import.meta.url)));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${pageServer.address().port}/phone/index.html`, join(box.dir, 'remote-phone-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('typeof data === "object" && !!data?.project');
    assert.equal(await chrome.stable('data.project.items[0].title'), 'Remote original');
    await chrome.click(`document.querySelector('[data-tab="items"]')`); // a person opens Items before the list is drawn, since pages open on the Dashboard.
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
