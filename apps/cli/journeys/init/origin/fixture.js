/** Shared helpers for the hosted-page journeys: a stand-in for the hosted page, a named-port view and one plain HTTP call [N26,A2]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { test } from 'node:test';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import {
  BIN,
  machine,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  chromeHealth,
  networkServicePids,
} from '../../../tests/fixtures/cockpit/health.js';

export const HOSTED = 'https://app.pullboard.dev';

/** Navigate to the real Items pane after the hosted page is ready, where its board rows are rendered. */
export async function showItemChain(chrome, ready, title, timeout = 30_000) {
  await chrome.waitFor(ready, timeout);
  // A fresh board opens on the first-run Dashboard; set it aside so the Items tab under test renders.
  await chrome.stable("(() => { try { keep('pb.firstrun.' + view.root, 'hidden'); render(); } catch {} return true; })()");
  await press(chrome, "document.querySelector('[data-tab=items]')");
  await chrome.waitFor(`document.querySelector('[data-tab=items].on') && document.querySelector('#chain')?.textContent.includes(${JSON.stringify(title)})`, timeout);
}

/** What the hosted page showed, for a wait that failed: its address, state, rows, detail and sessions (#908). */
export const HOSTED_FACTS = `JSON.stringify({ origin: location.origin, search: location.search,
  note: document.querySelector('#local-note')?.hidden ? null : document.querySelector('#local-note')?.dataset.state ?? null,
  rows: document.querySelectorAll('#proj-list .proj.repo, #chain .row').length, detail: (document.querySelector('#detail')?.textContent || '').trim().slice(0, 120),
  relaySession: typeof hosted === 'undefined' ? null : hosted.relaySession, localSession: typeof localSession === 'undefined' ? null : Boolean(localSession),
  transport: typeof transport === 'undefined' ? null : Boolean(transport) })`;

/** Make each failed wait on this Chrome name the hosted page state it saw and Chrome's network-service health (#908). */
export function namedWaits(chrome, profile) {
  const networkAtStart = networkServicePids(profile);
  const waitFor = chrome.waitFor.bind(chrome);
  chrome.waitFor = async (...args) => {
    try { return await waitFor(...args); }
    catch (error) {
      try { error.message += '; the hosted page showed ' + await chrome.stable(HOSTED_FACTS); } catch { /* the page may be gone */ }
      try { error.message += '; chrome ' + JSON.stringify(chromeHealth(chrome, profile, networkAtStart)); } catch { /* the wait's own error stays the result */ }
      throw error;
    }
  };
  return chrome;
}
export const LOCAL = 'http://127.0.0.1:4890';

/** Start the real view on a named port, as pullboard view does, and wait until it answers its printed link. */
export async function viewAt(box, port) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', String(port)], { cwd: box.dir, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' } });
  const stop = () => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
  });
  try {
    const link = await new Promise((found, fail) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=\S+)/.exec(out);
        if (match) found(new URL(match[1]));
      });
      child.once('exit', (code) => fail(new Error(`view exited ${code}: ${out}`)));
    });
    return { link, key: link.searchParams.get('k'), base: link.origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** One plain HTTP request to the view, with exactly these headers, following nothing. */
export function call(view, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((done, fail) => {
    const outgoing = request(new URL(path, view.base), { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', fail);
    outgoing.end(body);
  });
}

/** Where a round-trip page sends the browser: the one address its script replaces the page with. */
export function onwardOf(page) {
  const literal = /location\.replace\(("(?:\\.|[^"\\])*")\)/.exec(page)?.[1];
  assert.ok(literal, 'the page sends the browser to one address');
  return new URL(JSON.parse(literal));
}

/**
 * The relay's own asset at a path, as its production handler serves it, or null when it serves none there. Why: the
 * relay page loads its own scripts (such as /relay/screens.js), and answering those with the view's styles throws in Chrome.
 */
export async function relayAsset(pathname) {
  let body = null;
  const handled = await createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) })({ method: 'GET', url: pathname, headers: {} }, { writeHead() {}, end(content) { body = content ?? ''; } });
  return handled ? body : null;
}

/**
 * Stand in for the hosted page at its real origin, and for this machine's default view address. Chrome answers every
 * request for https://app.pullboard.dev with the cockpit the relay would serve there and the view's styles. A request
 * for http://127.0.0.1:4890 goes to the test view, as if it held the default address, or meets a closed port when the
 * test names none: the suite never binds the machine's 4890, where a person's own view may run. The view's own state
 * endpoint is also intercepted for the old-version simulation; its event stream and other requests remain direct.
 */
export async function hostedStandIn(chrome, pages, styles, local) {
  const failures = [];
  const tasks = [];
  const listener = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, resourceType, request: asked } = message.params;
    tasks.push((async () => {
      const address = new URL(asked.url);
      const ownState = address.origin === local.own && address.pathname.startsWith('/api/v1/boards/') && address.pathname.endsWith('/state');
      if (address.origin === LOCAL || ownState) {
        const target = address.origin === LOCAL ? local.target : (local.relayTarget || local.target);
        if (!target) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
        const headers = Object.fromEntries(Object.entries(asked.headers).filter(([name]) => name.toLowerCase() !== 'host'));
        const reply = await call({ base: target }, address.pathname + address.search, { method: asked.method, headers, body: asked.postData ?? '' });
        let responseBody = reply.body;
        if (asked.method === 'GET' && reply.status === 200 && local.versionOverride && address.pathname.startsWith('/api/v1/boards/') && address.pathname.endsWith('/state')) {
          const document = JSON.parse(responseBody);
          if (document.state) document.state.releaseNotes.version = local.versionOverride;
          else if (document.delta?.replace?.releaseNotes) document.delta.replace.releaseNotes.version = local.versionOverride;
          responseBody = JSON.stringify(document);
        }
        return chrome.send('Fetch.fulfillRequest', {
          requestId, responseCode: reply.status,
          responseHeaders: Object.entries(reply.headers).filter(([name]) => !['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date'].includes(name)).map(([name, value]) => ({ name, value: String(value) })),
          body: Buffer.from(responseBody).toString('base64'),
        });
      }
      if (address.pathname === '/relay/client.js' && local.client) {
        return chrome.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(local.client).toString('base64'),
        });
      }
      if (address.pathname === '/api/v1/boards') {
        return chrome.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from(JSON.stringify({ version: 1, boards: local.linked ?? [], warnings: [] })).toString('base64'),
        });
      }
      const document = resourceType === 'Document';
      const page = pages[address.search.slice(1)] ?? (address.search === '?relay' ? pages.relay : pages.anonymous);
      // The transport stays each test's own: one that names none means the relay module never loads.
      const asset = pages.assets?.[address.pathname] ?? (document || address.pathname === '/relay/client.js' ? null : await relayAsset(address.pathname));
      await chrome.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: document ? 'text/html; charset=utf-8' : address.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
          // The connections #533's relay page allows, its own origin and the local view's default address, and here the
          // test view's own port, which the round trip names.
          ...(document ? [{ name: 'Content-Security-Policy', value: `connect-src 'self' ${LOCAL} http://localhost:4890 ${local.own}; frame-ancestors 'none'` }] : []),
        ],
        body: Buffer.from(document ? page : asset ?? styles).toString('base64'),
      });
    })().catch((error) => {
      // A reply that comes after the page stopped waiting, because it moved to its next visit, has nowhere to go: Chrome
      // dropped that request. It is not a failure; any other error still is (#834, as in open-board's stand-in, #829).
      if (!/Invalid InterceptionId/u.test(error.message)) failures.push(`${asked.url} (${resourceType}, ${requestId}): ${error.message}`);
    }));
  };
  chrome.socket.addEventListener('message', listener);
  await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }, { urlPattern: local.own + '/api/v1/boards/*/state*', requestStage: 'Request' }] });
  return async () => {
    chrome.socket.removeEventListener('message', listener);
    try { await Promise.all(tasks); } finally { await chrome.send('Fetch.disable'); }
    assert.deepEqual(failures, [], 'the stand-in hosted page was served');
  };
}
