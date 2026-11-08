// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../apps/cli/index.js';
import { machine, project, fetchLive, startView, chromeExecutable, browserPause, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

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
      response.end(readFileSync(new URL("../../apps/view/src/shell/view.css", import.meta.url), 'utf8'));
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
