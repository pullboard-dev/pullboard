// pullboard: browser
/** @pullboard-test-gui */
/** The local view answers only the hosted page: pairing hints, foreign origins, its secret and the key page [N26,A2]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../../index.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  styleOf,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  HOSTED,
  namedWaits,
  call,
  onwardOf,
  hostedStandIn,
} from './fixture.js';

test('a signed-in local view with linked metadata and no paired transport says how to pair [N26,H5]', { timeout: 60_000 }, async () => { // budget: one real local-view discovery/round trip and the resulting hosted list read.
  const executable = chromeExecutable();
  assert.ok(executable, 'the mixed local and relay state check needs real Chrome');
  const box = machine();
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-local-unpaired-'));
  const linked = [{ id: 'a'.repeat(32), repository: 'acme/web', linkedAt: 0 }];
  const client = 'export function rememberPairing() { return null; }\nexport async function createTransport() { return { async request(path) { if (path === "/api/v1/boards") { globalThis.__749transportListCalls = (globalThis.__749transportListCalls || 0) + 1; return { version: 1, boards: [], warnings: [] }; } throw new Error("no paired board"); } }; }\n';
  let view, chrome, stopStandIn;
  try {
    view = await startView(box);
    const direct = await call(view, '/api/v1/boards', { headers: { 'x-pullboard-key': view.key } });
    assert.equal(direct.status, 200, 'the real private view answers with its valid session key');
    assert.deepEqual(JSON.parse(direct.body).boards, [], 'the private view genuinely has no boards');
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)}) return;
      const nativeFetch = window.fetch.bind(window);
      window.__749fetches = [];
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        const address = new URL(String(typeof input === 'string' ? input : input.url), location.href);
        if (address.origin === ${JSON.stringify(HOSTED)} || ['127.0.0.1', 'localhost'].includes(address.hostname)) window.__749fetches.push({ origin: address.origin, path: address.pathname, status: response.status });
        return response;
      };
    })()` });
    const page = cockpitPage('', { readOnly: true, requests: true, transportModule: '/relay/client.js', apiHeaders: {}, stylesheet: '/view.css', hostedLocal: true, relaySession: true, signIn: '/auth/github/start' })
      .replace('<main>', '<main><section class="card-panel" id="relay-notice" role="status"><p>Relay status</p></section>');
    stopStandIn = await hostedStandIn(chrome, { anonymous: page, relay: page }, await styleOf(view), {
      own: view.base, target: view.base, linked,
      client,
    });
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
    }
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    // Wait for all independent authorities to finish, then make the state assertion directly. The condition does not
    // wait for an unpaired label; loading must finish before the semantic assertion, including the final metadata read.
    await chrome.waitFor(`location.origin === 'https://app.pullboard.dev' && sessionStorage.getItem('pullboard.local.session') && (window.__749fetches || []).some((x) => x.origin === ${JSON.stringify(view.base)} && x.path === '/api/v1/boards' && x.status === 200) && (window.__749fetches || []).some((x) => x.origin === 'https://app.pullboard.dev' && x.path === '/api/v1/boards' && x.status === 200) && window.__749transportListCalls >= 1 && !document.body.classList.contains('loading')`, 30_000); // budget: hang ceiling for local discovery, the round trip, the local list, linked metadata and the empty paired list.
    const seen = JSON.parse(await chrome.stable(`JSON.stringify({
      state: document.querySelector('#local-note')?.dataset.state ?? null,
      hidden: document.querySelector('#local-note')?.hidden ?? true,
      heading: document.querySelector('#local-note-title')?.textContent.trim() ?? null,
      text: document.querySelector('#local-note-text')?.textContent.trim() ?? null,
      command: document.querySelector('#local-note-code')?.textContent.trim() ?? null,
      hasSession: Boolean(sessionStorage.getItem('pullboard.local.session')),
      sessionOrigin: JSON.parse(sessionStorage.getItem('pullboard.local.session'))?.origin ?? null,
      localSessionMatches: (() => { const saved = JSON.parse(sessionStorage.getItem('pullboard.local.session')); return saved?.version === 1 && saved.origin === ${JSON.stringify(view.base)} && saved.key === ${JSON.stringify(view.key)}; })(),
      fetches: window.__749fetches,
      transportLists: window.__749transportListCalls,
      cards: document.querySelectorAll('#proj-list .proj').length,
    })`));
    assert.equal(seen.hasSession, true, 'the browser holds a tab-scoped local-view session');
    assert.equal(seen.sessionOrigin, view.base, 'the session names this private view');
    assert.equal(seen.localSessionMatches, true, 'the browser uses the private view session without returning its secret');
    assert.ok(seen.transportLists >= 1, 'the relay transport confirmed its real empty paired-board list');
    assert.ok(seen.fetches.some((x) => x.origin === view.base && x.path === '/api/v1/boards' && x.status === 200), 'the hosted page read the reachable private view');
    assert.ok(seen.fetches.some((x) => x.origin === 'https://app.pullboard.dev' && x.path === '/api/v1/boards' && x.status === 200), 'the hosted page read the signed-in account metadata');
    assert.equal(seen.state, 'unpaired', `linked account metadata with no paired transport must show pairing guidance, not the generic local empty state: ${JSON.stringify(seen)}`);
    assert.equal(seen.hidden, false);
    assert.equal(seen.heading, 'One step on your computer', 'the one step #757 names for a person with nothing open here');
    assert.equal(seen.command, 'pullboard relay on --all');
    assert.equal(seen.cards, 0, 'no local or paired board is falsely shown');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (stopStandIn) await stopStandIn(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { if (view) await view.stop(); }
        finally { rmSync(profile, { recursive: true, force: true }); }
      }
    }
  }
});

test('a foreign origin or wrong Host is refused by the local view [N26,A2]', { timeout: 60_000 }, async () => { // budget: hang ceiling for one real view and a few local requests.
  const box = machine();
  project(box, 'local-origin-refusals');
  const view = await startView(box);
  try {
    const port = view.link.port;
    const key = { 'x-pullboard-key': view.key };
    // Another site, even holding the secret, gets a plain refusal and no permission to read it.
    for (const path of ['/api/v1/boards', '/local/protocol', '/local/connect', '/?k=' + view.key]) {
      const foreign = await call(view, path, { headers: { ...key, origin: 'https://foreign.example' } });
      assert.equal(foreign.status, 403, `a foreign origin is refused at ${path.replace(view.key, '<key>')}`);
      assert.equal(foreign.headers['access-control-allow-origin'], undefined, 'and is not allowed to read the answer');
      assert.equal(JSON.parse(foreign.body).error, 'this view answers its own page and https://app.pullboard.dev only');
      assert.ok(!foreign.body.includes(view.key));
    }
    const foreignWrite = await call(view, '/api/v1/boards', { method: 'POST', headers: { ...key, origin: 'https://foreign.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(foreignWrite.status, 403, 'a foreign origin cannot write');
    const foreignPreflight = await call(view, '/api/v1/boards', { method: 'OPTIONS', headers: { origin: 'https://foreign.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-pullboard-key' } });
    assert.equal(foreignPreflight.status, 403, 'a foreign preflight is refused');
    assert.equal(foreignPreflight.headers['access-control-allow-private-network'], undefined);
    // A name of another site pointed at 127.0.0.1, as DNS rebinding sends it, reaches nothing.
    for (const path of ['/local/protocol', '/local/connect', '/?k=' + view.key]) {
      const rebound = await call(view, path, { headers: { ...key, host: 'foreign.example:' + port } });
      assert.equal(rebound.status, 403, `a wrong Host is refused at ${path.replace(view.key, '<key>')}`);
      assert.ok(!rebound.body.includes(view.key));
    }
    const reboundApi = await call(view, '/api/v1/boards', { headers: { ...key, host: 'foreign.example:' + port } });
    assert.equal(reboundApi.status, 401, 'the API refuses a wrong Host in its own words');
    assert.equal(JSON.parse(reboundApi.body).error.code, 'AUTH_REQUIRED');
    // The hosted page itself is refused without the secret in its header.
    const bare = await call(view, '/api/v1/boards', { headers: { origin: HOSTED } });
    assert.equal(bare.status, 403, 'the allowed origin without the secret is refused');
    assert.ok(!bare.body.includes(view.key));
    const queried = await call(view, '/api/v1/boards?k=' + view.key, { headers: { origin: HOSTED } });
    assert.equal(queried.status, 403, 'the allowed origin may not send the secret in a query');
    const bearer = await call(view, '/api/v1/boards', { headers: { origin: HOSTED, authorization: 'Bearer ' + view.key } });
    assert.equal(bearer.status, 403, 'nor in another header');
    const wrongKey = await call(view, '/api/v1/boards', { headers: { origin: HOSTED, 'x-pullboard-key': 'not-' + view.key } });
    assert.equal(wrongKey.status, 401, 'nor with a wrong secret');
    // With its header, the hosted page reads and writes, writes only as JSON.
    const preflight = await call(view, '/api/v1/boards', { method: 'OPTIONS', headers: { origin: HOSTED, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-pullboard-key', 'access-control-request-private-network': 'true' } });
    assert.equal(preflight.status, 204, 'the hosted page\'s preflight is answered');
    assert.equal(preflight.headers['access-control-allow-origin'], HOSTED);
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
    assert.match(preflight.headers['access-control-allow-headers'], /x-pullboard-key/);
    assert.match(preflight.headers.vary, /Origin/);
    const widened = await call(view, '/api/v1/boards', { method: 'OPTIONS', headers: { origin: HOSTED, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    assert.equal(widened.status, 403, 'a preflight for any other header is refused');
    const read = await call(view, '/api/v1/boards', { headers: { ...key, origin: HOSTED } });
    assert.equal(read.status, 200, 'the hosted page reads with its header');
    assert.equal(read.headers['access-control-allow-origin'], HOSTED);
    const id = JSON.parse(read.body).boards[0].id;
    const state = await call(view, `/api/v1/boards/${id}/state`, { headers: { ...key, origin: HOSTED } });
    assert.equal(state.status, 200);
    assert.match(state.headers['x-pullboard-report-validator'], /^[a-f0-9]{64}:[0-9]+$/u);
    assert.equal(state.headers['access-control-expose-headers'], 'x-pullboard-report-validator',
      'the already-allowed hosted browser may read the report token under CORS, without extra request authority');
    const sameOriginState = await call(view, `/api/v1/boards/${id}/state`, { headers: { ...key, origin: view.base } });
    assert.equal(sameOriginState.headers['access-control-expose-headers'], undefined,
      'same-origin reads need no new cross-origin permission');
    const shout = JSON.stringify({ verb: 'shout', args: { to: 'all', text: 'from the hosted page' } });
    const plain = await call(view, `/api/v1/boards/${id}/moves`, { method: 'POST', headers: { ...key, origin: HOSTED, 'content-type': 'text/plain' }, body: shout });
    assert.equal(plain.status, 400, 'a write that is not JSON is refused, as a form could send it');
    const moved = await call(view, `/api/v1/boards/${id}/moves`, { method: 'POST', headers: { ...key, origin: HOSTED, 'content-type': 'application/json' }, body: shout });
    assert.equal(moved.status, 200, `the hosted page writes as JSON: ${moved.body}`);
    // The view's own page and its printed link are as before.
    const own = await call(view, '/api/v1/boards', { headers: { ...key, origin: view.base } });
    assert.equal(own.status, 200, 'the view\'s own page still reads');
    assert.equal(own.headers['access-control-allow-origin'], undefined, 'and needs no cross-origin permission');
    const openedLink = await call(view, view.link.pathname + view.link.search);
    assert.equal(openedLink.status, 303, 'the printed link first exchanges its key');
    const openedCookie = (openedLink.headers['set-cookie'] ?? [])[0]?.split(';')[0];
    assert.ok(openedCookie, 'the printed link sets its session cookie');
    const cleanLink = await call(view, openedLink.headers.location ?? '/', { headers: { cookie: openedCookie } });
    assert.equal(cleanLink.status, 200, 'the clean address opens the board with the exchanged cookie');
  } finally {
    await view.stop();
  }
});

test('the local view hands its secret only to the hosted page [N26,A2]', { timeout: 60_000 }, async () => { // budget: hang ceiling for one real view and a few local requests.
  const box = machine();
  project(box, 'local-origin-handoff');
  const view = await startView(box);
  try {
    const trip = await call(view, '/local/connect', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } });
    assert.equal(trip.status, 200, 'any page may start the round trip with a top-level visit, without the secret');
    assert.equal(trip.headers['x-frame-options'], 'DENY', 'the round-trip page refuses to be framed');
    assert.match(trip.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(trip.headers['referrer-policy'], 'no-referrer');
    assert.equal(trip.headers['cache-control'], 'no-store');
    assert.match(trip.body, /if \(window\.top === window\.self\)/, 'a framed copy never runs its redirect');
    const onward = onwardOf(trip.body);
    assert.equal(onward.origin, HOSTED, 'the secret goes back to https://app.pullboard.dev only');
    assert.equal(onward.pathname, '/');
    assert.equal(onward.search, '', 'never in a query');
    assert.deepEqual(JSON.parse(new URLSearchParams(onward.hash.slice(1)).get('pullboard-local')), { version: 1, origin: view.base, key: view.key }, 'only in the fragment');
    const elsewhere = onwardOf((await call(view, '/local/connect?return=' + encodeURIComponent('https://foreign.example/'))).body);
    assert.equal(elsewhere.origin, HOSTED, 'no address a page names can turn the round trip elsewhere');
    // A script's read, a frame and another site's name get nothing.
    for (const [why, headers] of [
      ['a script on the hosted page', { origin: HOSTED, 'sec-fetch-dest': 'empty' }],
      ['a script on another site', { origin: 'https://foreign.example' }],
      ['a frame', { 'sec-fetch-dest': 'iframe' }],
      ['a script tag', { 'sec-fetch-dest': 'script' }],
      ['another site\'s name for this address', { host: 'foreign.example:' + view.link.port }],
    ]) {
      const refused = await call(view, '/local/connect', { headers });
      assert.equal(refused.status, 403, `${why} is refused`);
      assert.ok(!refused.body.includes(view.key), `${why} gets no secret`);
    }
    const protocol = await call(view, '/local/protocol', { headers: { origin: HOSTED } });
    assert.equal(protocol.status, 200, 'the hosted page can read what this view speaks');
    assert.equal(protocol.headers['access-control-allow-origin'], HOSTED);
    assert.deepEqual(JSON.parse(protocol.body), { version: 1, apiVersion: 1, hostedOrigin: HOSTED, connect: '/local/connect', view: '/local/view' }, 'and nothing else: no secret and no board');
    const opened = onwardOf((await call(view, '/local/view')).body);
    assert.equal(opened.origin, view.base, 'the local view link opens this view itself');
    assert.equal(opened.searchParams.get('k'), view.key, 'as the link pullboard view printed does');
  } finally {
    await view.stop();
  }
});

test('a browser without the key gets a page that sends it to app.pullboard.dev [N26,A2]', { timeout: 60_000 }, async () => { // budget: hang ceiling for one native view and local HTTP requests.
  const box = machine();
  project(box, 'bare-view-guidance');
  const view = await startView(box);
  try {
    const refusal = 'this view needs its own address and secret: open the link pullboard view printed';
    const page = await call(view, '/', { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } });
    assert.ok([200, 401].includes(page.status), 'a browser receives a usable guidance page');
    assert.match(page.headers['content-type'], /^text\/html\b/);
    assert.match(page.body, /href=["']https:\/\/app\.pullboard\.dev\/?["']/);
    assert.match(page.body, /board.*app\.pullboard\.dev/iu);
    assert.ok(!page.body.includes(view.key), 'the public guidance contains no view key');
    const ordinary = await call(view, '/', { headers: { accept: 'text/html' } });
    assert.ok([200, 401].includes(ordinary.status));
    assert.match(ordinary.headers['content-type'], /^text\/html\b/, 'ordinary HTML clients need not send Fetch Metadata');
    for (const headers of [{ accept: 'application/json' }, { accept: '*/*', 'sec-fetch-dest': 'empty' }, { accept: 'text/javascript' }, { accept: 'text/html', 'sec-fetch-dest': 'empty' }, { accept: 'text/html', 'sec-fetch-dest': 'script' }, { accept: 'text/html', 'sec-fetch-dest': 'iframe' }]) {
      const script = await call(view, '/', { headers });
      assert.equal(script.status, 403);
      assert.match(script.headers['content-type'], /^application\/json\b/);
      assert.deepEqual(JSON.parse(script.body), { error: refusal });
    }
    const wrong = await call(view, '/?k=wrong', { headers: { accept: 'application/json' } });
    assert.equal(wrong.status, 403);
    assert.deepEqual(JSON.parse(wrong.body), { error: refusal });
    for (const [path, headers] of [['/?k=wrong', {}], ['/', { 'x-pullboard-key': 'wrong' }], ['/', { 'x-pullboard-key': '' }]]) {
      const explicit = await call(view, path, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document', ...headers } });
      assert.equal(explicit.status, 403, 'an explicitly supplied invalid key keeps its refusal');
      assert.match(explicit.headers['content-type'], /^application\/json\b/);
      assert.deepEqual(JSON.parse(explicit.body), { error: refusal });
    }
    const api = await call(view, '/api/v1/boards', { headers: { accept: 'text/html' } });
    assert.equal(api.status, 401, 'HTML negotiation preserves the API authentication refusal');
    assert.equal(JSON.parse(api.body).error.code, 'AUTH_REQUIRED');
    assert.match(api.headers['content-type'], /^application\/json\b/);
    const authenticated = await call(view, '/?k=' + encodeURIComponent(view.key), { headers: { accept: 'text/html' } });
    assert.equal(authenticated.status, 303, 'the printed private link exchanges its key and redirects');
    const cookie = (authenticated.headers['set-cookie'] ?? [])[0]?.split(';')[0];
    assert.ok(cookie, 'the exchange sets the private-view cookie');
    const clean = await call(view, authenticated.headers.location ?? '/', { headers: { accept: 'text/html', cookie } });
    assert.equal(clean.status, 200, 'the clean private address opens with the cookie alone');
    assert.ok(!clean.body.includes('The board opens at app.pullboard.dev'), 'authenticated board is not replaced by public guidance');
  } finally { await view.stop(); }
});
