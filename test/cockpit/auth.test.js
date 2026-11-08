// pullboard: browser
/** @pullboard-test-gui */
/**
 * The view's secret leaves the address bar (N39, N26): the printed link's key is traded for a
 * session cookie, and every later request is authorized by that cookie, over real HTTP.
 */
import { main as nativeTestMain } from '../native-cli-fixture.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveView } from '../../apps/cli/src/shell/commands/view.js';
import { chromeExecutable, closeSnapshotChrome, openSnapshotChrome } from './fixture.js';

/**
 * Send one GET to a running view on a connection of its own, following no redirect, so the test sees
 * each answer the browser would; `host` replaces the Host header to stand in for another site.
 *
 * @param {number} port
 * @param {string} path
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function get(port, path, headers = {}) {
  return new Promise((done, fail) => {
    const outbound = request({ host: '127.0.0.1', port, path, agent: false, headers: { connection: 'close', ...headers } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    outbound.once('error', fail);
    outbound.setTimeout(10_000, () => outbound.destroy(new Error(`GET ${path.split('?')[0]} timed out`)));
    outbound.end();
  });
}

/**
 * Open a printed link's address, check it trades the key for one session cookie and lands on the same
 * address without the key, and return that cookie's name=value pair and where it landed.
 *
 * @param {number} port
 * @param {string} path
 * @param {string} key
 * @returns {Promise<{ pair: string, landed: URL }>}
 */
async function exchange(port, path, key) {
  const opened = await get(port, path);
  assert.equal(opened.status, 303, `${path.split('?')[0]}: the link with the key redirects`);
  const landed = new URL(opened.headers.location ?? '', `http://127.0.0.1:${port}`);
  assert.equal(landed.origin, `http://127.0.0.1:${port}`, 'the redirect stays on this view');
  assert.equal(landed.searchParams.has('k'), false, 'the redirect drops the key from the address');
  assert.ok(!landed.href.includes(key), 'the key appears nowhere in the new address');
  const cookies = opened.headers['set-cookie'] ?? [];
  assert.equal(cookies.length, 1, 'the exchange sets one cookie');
  const [pair, ...attributes] = cookies[0].split(';').map((part) => part.trim());
  const named = attributes.map((attribute) => attribute.toLowerCase());
  assert.ok(named.includes('httponly'), 'the cookie is HttpOnly, so no script on the page can read it');
  assert.ok(named.includes('samesite=strict'), 'the cookie is SameSite=Strict, so another site cannot send it');
  assert.ok(named.includes('path=/'), 'the cookie covers the whole view');
  assert.ok(!named.some((attribute) => attribute.startsWith('domain=')), 'the cookie is host-only');
  const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
  assert.match(name, /^pullboard_view_[0-9a-f]{16,}$/u, "the cookie's name is the view's, with a session part");
  assert.ok(value.length >= 16, 'the cookie has a value');
  assert.ok(!value.includes(key) && !key.includes(value), 'the cookie is a session value, never the key itself');
  return { pair, landed };
}

test('[N39,N26] the view key becomes a cookie', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-view-auth-'));
  const before = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  t.after(() => {
    if (before === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = before;
    rmSync(home, { recursive: true, force: true });
  });
  const open = new Set();
  /** Start a view session and close it after the test unless the test closes it first. */
  const start = async (port) => {
    const served = await serveView({ port, runCommand: nativeTestMain });
    open.add(served);
    return { ...served, close: async () => { if (open.delete(served)) await served.close(); } };
  };
  t.after(() => Promise.all([...open].map((served) => served.close())));
  const view = await start(0);
  const link = new URL(view.url);
  const key = link.searchParams.get('k') ?? '';
  const { port } = view;
  assert.ok(key, 'the printed link carries the key');

  // Opening the printed link trades the key for the cookie and lands on the same address without it.
  const { pair, landed } = await exchange(port, link.pathname + link.search, key);
  assert.equal(landed.pathname + landed.search, '/', 'the printed link lands on the clean board address');
  const routed = await exchange(port, `/roadmap?q=launch&k=${encodeURIComponent(key)}`, key);
  assert.equal(routed.landed.pathname + routed.landed.search, '/roadmap?q=launch', 'any address keeps its path and other parameters');
  assert.equal(routed.pair, pair, 'one session, one cookie');
  const opened = await get(port, `/roadmap?k=${encodeURIComponent(key)}`);
  assert.equal(opened.headers.location, '/roadmap', 'the redirect is relative, so a page opened through a proxy stays behind it');
  for (const path of [`//pullboard.example/?k=${encodeURIComponent(key)}`, `/\\pullboard.example/?k=${encodeURIComponent(key)}`]) {
    const elsewhere = await get(port, path);
    assert.ok(!/^[/\\]{2}|^[a-z]+:/iu.test(String(elsewhere.headers.location ?? '/')), `${path.split('?')[0]}: the redirect never names another host`);
  }

  // The clean address works with the cookie alone: the page, its stylesheet and its API.
  const page = await get(port, '/', { cookie: pair });
  assert.equal(page.status, 200, 'the clean address serves the page with the cookie alone');
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.ok(!page.body.includes(key), 'the page itself holds no key');
  assert.match(page.body, /<link rel="stylesheet" href="\/view\.css">/, 'the page links its stylesheet without the key');
  assert.equal((await get(port, '/roadmap?q=launch', { cookie: pair })).status, 200, 'a routed clean address works too');
  assert.equal((await get(port, '/view.css', { cookie: `theme=dark; ${pair}` })).status, 200, 'the stylesheet loads by the cookie among others');
  const boards = await get(port, '/api/v1/boards', { cookie: pair });
  assert.equal(boards.status, 200, 'the page API accepts the cookie');
  assert.equal(JSON.parse(boards.body).version, 1);

  // Neither cookie nor key is refused, as is a cookie with the wrong value or name, or a doubled one.
  for (const headers of [{}, { cookie: `${pair.split('=')[0]}=not-this-session` }, { cookie: `${pair}; ${pair}` }, { cookie: `${pair}x` }, { cookie: `pullboard_view_${port}=${pair.split('=')[1]}` }]) {
    const label = JSON.stringify(Object.keys(headers).length ? 'a wrong cookie' : 'nothing');
    assert.equal((await get(port, '/', headers)).status, 403, `the page refuses ${label}`);
    assert.equal((await get(port, '/view.css', headers)).status, 403, `the stylesheet refuses ${label}`);
    assert.equal((await get(port, '/api/v1/boards', headers)).status, 401, `the API refuses ${label}`);
  }
  assert.equal((await get(port, '/?k=not-the-key')).status, 403, 'a wrong key in the address is refused');
  assert.equal((await get(port, '/?k=not-the-key')).headers['set-cookie'], undefined, 'and gets no cookie');

  // A foreign Host or Origin is refused even with the cookie, and a foreign Host gets no cookie for the key.
  const foreignHost = { host: `pullboard.example:${port}` };
  assert.equal((await get(port, '/', { ...foreignHost, cookie: pair })).status, 403, 'the page refuses another Host, cookie or not');
  assert.equal((await get(port, '/api/v1/boards', { ...foreignHost, cookie: pair })).status, 401, 'the API refuses another Host, cookie or not');
  const rebound = await get(port, link.pathname + link.search, foreignHost);
  assert.equal(rebound.status, 403, 'a rebound name cannot open the printed link');
  assert.equal(rebound.headers['set-cookie'], undefined, 'and gets no cookie from it');
  const foreignOrigin = { origin: 'http://pullboard.example', cookie: pair };
  assert.equal((await get(port, '/', foreignOrigin)).status, 403, 'the page refuses another Origin, cookie or not');
  assert.equal((await get(port, '/api/v1/boards', foreignOrigin)).status, 403, 'the API refuses another Origin, cookie or not');

  for (const path of ['/', '/api/v1/boards', '/api/v1/view-link']) {
    assert.equal((await get(port, path, { cookie: pair, 'sec-fetch-site': 'same-site' })).status >= 400, true, 'a same-site foreign-port request cannot borrow the cookie');
    assert.equal((await get(port, path, { cookie: pair, origin: 'https://app.pullboard.dev' })).status >= 400, true, 'the hosted origin still needs its explicit key header');
  }
  assert.equal((await get(port, '/', { cookie: pair, 'sec-fetch-site': 'none' })).status, 403, 'a typed-site marker without a top-level document destination cannot use the cookie');
  assert.equal((await get(port, '/api/v1/view-link', { cookie: pair })).status, 200, 'the local invitation uses the cookie too');

  // The key is not single-use: the printed link opens again, and scripts still send it as a header.
  const again = await exchange(port, link.pathname + link.search, key);
  assert.equal((await get(port, '/', { cookie: again.pair })).status, 200, 'opening the printed link again still works');
  assert.equal((await get(port, '/', { 'x-pullboard-key': key })).status, 200, 'the key header still opens the page for scripts');
  assert.equal((await get(port, '/api/v1/boards', { 'x-pullboard-key': key })).status, 200, 'and the API');

  // A second view on another port shares the browser's cookie jar for 127.0.0.1, and refuses the first's cookie.
  const second = await start(0);
  assert.notEqual(second.port, port);
  const secondLink = new URL(second.url);
  const own = await exchange(second.port, secondLink.pathname + secondLink.search, secondLink.searchParams.get('k') ?? '');
  assert.notEqual(own.pair.split('=')[0], pair.split('=')[0], 'each view session names its own cookie');
  assert.notEqual(own.pair.split('=')[1], pair.split('=')[1], 'and gives it its own value');
  const borrowed = `${own.pair.split('=')[0]}=${pair.split('=')[1]}`;
  for (const cookie of [pair, borrowed]) {
    assert.equal((await get(second.port, '/', { cookie })).status, 403, "another view's page refuses this view's cookie");
    assert.equal((await get(second.port, '/api/v1/boards', { cookie })).status, 401, "another view's API refuses this view's cookie");
  }
  assert.equal((await get(port, '/', { cookie: own.pair })).status, 403, "and this view refuses the other's");
  assert.equal((await get(port, '/', { cookie: `${own.pair}; ${pair}` })).status, 200, 'both cookies in one jar still open each view');
  assert.equal((await get(second.port, '/', { cookie: `${own.pair}; ${pair}` })).status, 200);

  // A later session on the same port gets a new cookie name and value, and refuses the old session's cookie.
  await view.close();
  const later = await start(port);
  assert.equal(later.port, port, 'the later session serves from the same port');
  const laterLink = new URL(later.url);
  const renewed = await exchange(port, laterLink.pathname + laterLink.search, laterLink.searchParams.get('k') ?? '');
  assert.notEqual(renewed.pair.split('=')[0], pair.split('=')[0], 'two sessions on one port name their cookies differently');
  assert.notEqual(renewed.pair.split('=')[1], pair.split('=')[1], 'and give them different values');
  assert.equal((await get(port, '/', { cookie: pair })).status, 403, "the later session's page refuses the earlier session's cookie");
  assert.equal((await get(port, '/api/v1/boards', { cookie: pair })).status, 401, "and so does its API");
  assert.equal((await get(port, '/', { cookie: `${pair}; ${renewed.pair}` })).status, 200, 'its own cookie opens it beside the stale one');
});

test('[N39,N26] a direct browser visit can use its view cookie', { timeout: 60_000 }, async (t) => { // budget: hang ceiling for one real Chrome navigation and its same-origin control.
  const executable = chromeExecutable();
  assert.ok(executable, 'the direct-navigation cookie check needs real Chrome');
  const home = mkdtempSync(join(tmpdir(), 'pullboard-view-cookie-navigation-'));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-view-cookie-chrome-'));
  const before = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  let view, chrome, timer;
  t.after(async () => {
    clearTimeout(timer);
    if (before === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = before;
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally {
      try { if (view) await view.close(); }
      finally { rmSync(profile, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
    }
  });

  view = await serveView({ runCommand: nativeTestMain });
  chrome = await openSnapshotChrome(executable, 'about:blank', profile);
  const base = new URL(view.url);
  const navigation = [];
  const byNetwork = new Map();
  const recordsByRequest = new Map();
  const extraByRequest = new Map();
  let resolveCleanResponse;
  const cleanResponse = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Chrome did not report the clean page response')), 15_000); // budget: hang ceiling for one local HTTP redirect and final response.
    resolveCleanResponse = resolve;
  });
  /** Pair ordered request-extra-info rows with the corresponding redirect-chain request without retaining secrets. */
  const pairExtraHeaders = (requestId) => {
    const records = recordsByRequest.get(requestId) ?? [];
    const extras = extraByRequest.get(requestId) ?? [];
    while (records.length && extras.length) {
      const record = records.shift();
      const headers = Object.fromEntries(Object.entries(extras.shift()).map(([name, value]) => [name.toLowerCase(), value]));
      record.fetchSite = headers['sec-fetch-site'] ?? null;
      record.hasCookie = headers.cookie !== undefined;
      record.extraHeadersSeen = true;
      if (record.status !== null && !record.hasKeyQuery) {
        resolveCleanResponse?.(record);
        resolveCleanResponse = null;
      }
    }
    if (!records.length) recordsByRequest.delete(requestId);
    if (!extras.length) extraByRequest.delete(requestId);
  };
  /** Keep only the URL shape, fetch-metadata value and status; never retain the key or cookie value. */
  const observe = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, request, redirectResponse } = message.params;
      const asked = new URL(request.url);
      if (asked.origin === base.origin && asked.pathname === '/') {
        const record = {
          networkId: requestId,
          hasKeyQuery: asked.searchParams.has('k'),
          fetchSite: null,
          hasCookie: false,
          hasKeyHeader: Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === 'x-pullboard-key'),
          hasAuthorization: Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === 'authorization'),
          redirectStatus: redirectResponse?.status ?? null,
          status: null,
          extraHeadersSeen: false,
        };
        navigation.push(record);
        const records = recordsByRequest.get(requestId) ?? [];
        records.push(record);
        recordsByRequest.set(requestId, records);
        if (!record.hasKeyQuery) byNetwork.set(requestId, record);
        pairExtraHeaders(requestId);
      }
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') {
      const extras = extraByRequest.get(message.params.requestId) ?? [];
      extras.push(message.params.headers ?? {});
      extraByRequest.set(message.params.requestId, extras);
      pairExtraHeaders(message.params.requestId);
    }
    if (message.method === 'Network.responseReceived') {
      const record = byNetwork.get(message.params.requestId);
      if (!record) return;
      record.status = message.params.response.status;
      if (record.extraHeadersSeen) {
        resolveCleanResponse?.(record);
        resolveCleanResponse = null;
      }
    }
  };
  chrome.socket.addEventListener('message', observe);
  t.after(() => chrome?.socket.removeEventListener('message', observe));

  await chrome.send('Page.navigate', { url: view.url });
  const clean = await cleanResponse;
  clearTimeout(timer);
  await chrome.waitFor("document.readyState === 'complete'");
  const sameOriginStatus = await chrome.stable("fetch('/api/v1/boards').then(response => response.status)");
  assert.equal(sameOriginStatus, 200, 'the same Chrome session can use the cookie on an ordinary same-origin API request');
  assert.equal(clean.redirectStatus, 303, 'the first keyed navigation exchanges the key before its clean request');
  assert.equal(clean.fetchSite, 'none', 'Chrome marks the redirect-following top-level visit as typed/bookmarked');
  assert.equal(clean.hasCookie, true, 'Chrome sends the exchanged cookie on the clean page request');
  assert.equal(clean.hasKeyQuery, false, 'the clean page request has no key in its address');
  assert.equal(clean.hasKeyHeader, false, 'the clean page request has no secret header');
  assert.equal(clean.hasAuthorization, false, 'the clean page request has no authorization header');
  assert.equal(clean.status, 200, 'the cookie opens the clean top-level page');
  assert.equal(new URL(await chrome.stable('location.href')).search, '', 'the visible address stays clean');
  assert.ok(navigation.length >= 2, 'Chrome made both the keyed and clean page requests');
});
