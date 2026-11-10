// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
} from 'node:fs';
import {
  createServer,
  request,
} from 'node:http';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../index.js';
import {
  scratch,
  SPEC,
  machine,
  project,
  fetchLive,
  startView,
  target,
  chromeExecutable,
  openSnapshotChrome,
  stopOwnedChrome,
} from '../../tests/fixtures/cockpit/harness.js';

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
      response.end(readFileSync(new URL("../../../view/src/io/main.css", import.meta.url), 'utf8'));
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
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.click(`document.querySelector('[data-tab="items"]')`);
    await chrome.waitFor("typeof data === 'object' && !!data?.project && [...document.querySelectorAll('#needs .needs-call')].some(row => row.textContent.includes('Should the read-only fixture ship?'))");
    /** Read Needs-you labels with absolute API age timestamps so the comparison survives minute ticks. */
    const readNeedEntries = () => chrome.stable(`JSON.stringify([...document.querySelectorAll('#needs .needs-call')].map((row) => {
      const time = row.querySelector('.needs-age time'), ref = row.querySelector('.needs-id');
      return [ref?.textContent ?? null, row.querySelector('.needs-copy b')?.textContent.slice((ref?.textContent ?? '').length) ?? row.textContent,
        (row.querySelector('.needs-copy small')?.textContent ?? '') + (time ? ' @' + time.dataset.ago : '')];
    }))`);
    const normalEntries = JSON.parse(await readNeedEntries());
    assert.deepEqual(normalEntries.map((row) => row[0]), ['G3', '#' + await chrome.stable('data.project.decisions[0].shout_id'), 'web', null], 'the normal Needs-you list contains the decision, pending row, held lane, and draft summary');
    assert.match(normalEntries[1][2], /^Asked by coordinator @[^ ]+$/, 'the API-provided decision timestamp is shown as an age; a seat with no declared model shows its bare id (5665f8678a)');
    assert.match(normalEntries[2][2], /^lane held by coordinator @[^ ]+$/, 'the holder and API-provided hold timestamp are shown as an age');
    await chrome.click(`document.querySelector('#needs .needs-drafts [data-go="tab:spec"]')`);
    await chrome.waitFor('view.tab === "spec"');
    assert.equal(await chrome.stable('data.project.spec.some(row => row.id === "G4" && row.status === "draft")'), true,
      'the normal draft-summary button opens Spec while retaining the actual draft row');
    await chrome.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
    await chrome.waitFor("typeof data === 'object' && document.body?.classList.contains('read-only') && !!data?.project && typeof window.__transportUpdate === 'function'");
    await chrome.click(`document.querySelector('[data-tab="items"]')`);
    await chrome.waitFor("[...document.querySelectorAll('#needs .needs-call')].some(row => row.textContent.includes('Should the read-only fixture ship?'))");
    const readOnlyEntries = JSON.parse(await readNeedEntries());
    assert.deepEqual(readOnlyEntries, normalEntries, 'read-only Needs-you preserves the normal entries and their API-provided asker and ages');
    assert.equal(await chrome.stable("document.querySelectorAll('#needs button, #needs [data-go], #needs [data-new], #needs [data-shout], #needs [data-release]').length"), 0,
      'read-only Needs-you entries contain no answer, approve, navigation, or other action controls');
    const calls = JSON.parse(await chrome.stable('JSON.stringify(window.__transportCalls)'));
    assert.ok(calls.some((call) => call.path === '/api/v1/boards'));
    assert.ok(calls.some((call) => call.path.startsWith('/api/v1/boards/') && call.path.endsWith('/state')));
    assert.equal(await chrome.stable("document.querySelector('#live').textContent"), '', 'read-only transport keeps the page live, which says nothing');
    await chrome.click(`document.querySelector('#chain [data-item]')`);
    await chrome.waitFor("document.querySelector('#detail [data-shout]') !== null");
    await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor("document.querySelector('[data-release]') !== null && !!document.querySelector('#feed [data-shout-thread=\"none\"]')");
    // Read-only Shouts never renders the decision's Answer button (3a98fbee36), so open its no-item conversation and find none.
    await chrome.click(`document.querySelector('#feed [data-shout-thread="none"]')`);
    await chrome.waitFor("!!document.querySelector('#feed .conversation-heading') && document.querySelector('#feed').textContent.includes('Should the read-only fixture ship?')");
    assert.equal(await chrome.stable(`document.querySelectorAll('[data-go^="decide:"]').length`), 0, 'the open read-only decision conversation renders no Answer control');
    const actionSelectors = ['#new-item', '#add-form', '#shout-form', '#hold-form', '[data-release]', '[data-shout]', '[data-new]'];
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
    const refreshed = JSON.parse(await chrome.stable("JSON.stringify({ samePage: window.__samePage === true, titles: (data?.project?.items || []).map((item) => item.title), live: document.querySelector('#live').textContent, calls: window.__transportCalls.slice(-4) })"));
    assert.equal(refreshed.samePage, true, 'onUpdate refreshes in the same page');
    assert.ok(refreshed.titles.includes('Transport refresh item'), 'onUpdate refreshes state in the same page without relying on the poll: ' + JSON.stringify(refreshed));
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
