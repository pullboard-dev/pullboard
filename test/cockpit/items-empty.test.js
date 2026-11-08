// pullboard: browser
/** @pullboard-test-gui */
/** The default Items view gives finished work a clear next step [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../apps/cli/index.js';
import { accept, build, chromeExecutable, fetchLive, machine, openSnapshotChrome, press, project, startView, tapTouch } from './fixture.js';

/** Serve the supported live read-only page over the fixture's authenticated board API. */
async function startReadOnlyView(view) {
  const transport = `export async function createTransport() { return { async request(path) { const reply = await fetch('/upstream' + path); if (!reply.ok) throw new Error('private board read failed'); return reply.json(); } }; }`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method !== 'GET') return response.writeHead(405).end();
      if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' })
        .end(cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
      if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transport);
      if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' })
        .end(readFileSync(new URL("../../apps/view/src/shell/view.css", import.meta.url)));
      if (!url.pathname.startsWith('/upstream/')) return response.writeHead(404).end();
      const reply = await fetchLive(view.base + url.pathname.slice('/upstream'.length) + url.search,
        { headers: { 'x-pullboard-key': view.key } });
      return response.writeHead(reply.status, { 'content-type': 'application/json' }).end(await reply.text());
    } catch {
      return response.writeHead(502).end('private board API unavailable');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

/** Close only the read-only proxy server and its accepted connections. */
async function stopReadOnlyView(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

/** Check the exact empty-state action against one live page mode. */
async function checkFinishedItems(executable, address, readOnly, label, box, touch = false) {
  const profile = mkdtempSync(join(box.dir, 'items-empty-' + label + '-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, address, profile);
    if (touch) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await chrome.waitFor("innerWidth === 390 && matchMedia('(pointer: coarse)').matches");
    }
    await chrome.waitFor("document.querySelector('#chain .empty') || document.querySelector('#chain .row[data-item=\"1\"]')");
    const initial = JSON.parse(await chrome.stable(`JSON.stringify({
      state: view.state,
      snapshot,
      readOnly,
      visibleRows: [...document.querySelectorAll('#chain .row')].filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && getComputedStyle(row).visibility === 'visible';
      }).map((row) => row.dataset.item),
      empty: document.querySelector('#chain .empty')?.textContent.trim() ?? '',
      action: document.querySelector('#chain .empty [data-filter-choice=\"state:all\"]')?.textContent.trim() ?? '',
    })`));
    assert.equal(initial.snapshot, false, label + ' is a live page, not static replay');
    assert.equal(initial.readOnly, readOnly, label + ' uses its declared access mode');
    if (initial.visibleRows.includes('1')) {
      assert.deepEqual(chrome.exceptions, [], label + ' produces no browser exceptions');
      return;
    }
    assert.equal(initial.state, 'active', label + ' starts on the default Active filter');
    assert.deepEqual(initial.visibleRows, [], label + ' hides the all-verified item under Active');
    assert.doesNotMatch(initial.empty, /\n/, label + ' keeps the explanation on one line');
    assert.match(initial.empty, /finished work is under All/i, label + ' explains where the accepted item went');
    assert.ok(initial.action, label + ' provides the one-click All filter action');
    const action = "document.querySelector('#chain .empty [data-filter-choice=\"state:all\"]')";
    if (touch) await tapTouch(chrome, action);
    else await press(chrome, action);
    await chrome.waitFor("view.state === 'all' && (() => { const row = document.querySelector('#chain .row[data-item=\"1\"]'); const bounds = row?.getBoundingClientRect(); return bounds?.width > 0 && bounds?.height > 0 && getComputedStyle(row).visibility === 'visible'; })()");
    assert.equal(await chrome.stable("document.querySelector('#chain .row[data-item=\"1\"]').getAttribute('title')"), 'Finished item',
      label + ' reveals the accepted item with one Show all click');
    assert.deepEqual(chrome.exceptions, [], label + ' produces no browser exceptions');
  } finally {
    if (chrome) await chrome.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

test('a board whose work is all verified shows it or says it is under All [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the real-Chrome empty-state check requires Chrome');
  const box = machine();
  const alpha = project(box, 'all-verified');
  box.run(alpha.repo, 'add', 'web', 'Finished item', '--specs', 'G1', '--criterion', 'shows the page');
  build(box, alpha, 1, 'finished.html');
  accept(box, alpha, 1);

  const view = await startView(box);
  let readOnlyServer;
  try {
    await checkFinishedItems(executable, view.link.href, false, 'editable', box);
    readOnlyServer = await startReadOnlyView(view);
    await checkFinishedItems(executable, `http://127.0.0.1:${readOnlyServer.address().port}/`, true, 'read-only', box, true);
  } finally {
    if (readOnlyServer) await stopReadOnlyView(readOnlyServer);
    await view.stop();
  }
});
