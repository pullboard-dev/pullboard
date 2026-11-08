// pullboard: browser
/** @pullboard-test-gui */
/** The hosted page reads this machine's view straight, and the view answers only its own page and that one [N26,A2]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../apps/cli/index.js';
import { help$VERSION as VERSION } from '../../apps/cli/index.js';
import { Refused } from '../../packages/kernel/index.js';
import { createRelayBrowserHandler } from '../../relay/browser-page.js';
import { BIN, machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, styleOf, proofShot, press } from './fixture.js';
import {
  chromeHealth,
  networkServicePids,
} from './chrome-health.js';

const HOSTED = 'https://app.pullboard.dev';

/** Navigate to the real Items pane after the hosted page is ready, where its board rows are rendered. */
async function showItemChain(chrome, ready, title, timeout = 30_000) {
  await chrome.waitFor(ready, timeout);
  // A fresh board opens on the first-run Dashboard; set it aside so the Items tab under test renders.
  await chrome.stable("(() => { try { keep('pb.firstrun.' + view.root, 'hidden'); render(); } catch {} return true; })()");
  await press(chrome, "document.querySelector('[data-tab=items]')");
  await chrome.waitFor(`document.querySelector('[data-tab=items].on') && document.querySelector('#chain')?.textContent.includes(${JSON.stringify(title)})`, timeout);
}

/** What the hosted page showed, for a wait that failed: its address, state, rows, detail and sessions (#908). */
const HOSTED_FACTS = `JSON.stringify({ origin: location.origin, search: location.search,
  note: document.querySelector('#local-note')?.hidden ? null : document.querySelector('#local-note')?.dataset.state ?? null,
  rows: document.querySelectorAll('#proj-list .proj.repo, #chain .row').length, detail: (document.querySelector('#detail')?.textContent || '').trim().slice(0, 120),
  relaySession: typeof hosted === 'undefined' ? null : hosted.relaySession, localSession: typeof localSession === 'undefined' ? null : Boolean(localSession),
  transport: typeof transport === 'undefined' ? null : Boolean(transport) })`;

/** Make each failed wait on this Chrome name the hosted page state it saw and Chrome's network-service health (#908). */
function namedWaits(chrome, profile) {
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
const LOCAL = 'http://127.0.0.1:4890';

/** Start the real view on a named port, as pullboard view does, and wait until it answers its printed link. */
async function viewAt(box, port) {
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
function call(view, path, { method = 'GET', headers = {}, body = '' } = {}) {
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
function onwardOf(page) {
  const literal = /location\.replace\(("(?:\\.|[^"\\])*")\)/.exec(page)?.[1];
  assert.ok(literal, 'the page sends the browser to one address');
  return new URL(JSON.parse(literal));
}

/**
 * The relay's own asset at a path, as its production handler serves it, or null when it serves none there. Why: the
 * relay page loads its own scripts (such as /relay/screens.js), and answering those with the view's styles throws in Chrome.
 */
async function relayAsset(pathname) {
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
async function hostedStandIn(chrome, pages, styles, local) {
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

test('a pullboard.dev page reads the local board [N26,A2]', { timeout: 120_000 }, async () => { // budget: hang ceiling for two real round trips in Chrome, a view restart and the unreachable cases.
  const executable = chromeExecutable();
  assert.ok(executable, 'the hosted page check needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-local');
  box.run(board.repo, 'add', 'web', 'A board that stays on this machine', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-local-origin-'));
  let view, chrome, stopStandIn, other;
  try {
    view = await startView(box);
    const port = view.link.port;
    const local = { own: view.base, target: null };
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    // Each fetch the hosted page makes, with what the page showed and where its address stood as it made it.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)}) return;
      const nativeFetch = window.fetch.bind(window);
      const log = window.__localFetches = [];
      window.fetch = (input, init) => {
        const note = document.getElementById('local-note');
        log.push({ url: String(typeof input === 'string' ? input : input.url), address: location.href, note: note ? !note.hidden : false, state: note?.dataset.state ?? '' });
        return nativeFetch(input, init);
      };
    })()` });
    // The page as relay/browser-page.js serves it, with its own banner, which the relay client fills.
    const relayPage = (relaySession) => cockpitPage('', { readOnly: true, requests: true, transportModule: '/relay/client.js', apiHeaders: {}, stylesheet: '/view.css', hostedLocal: true, relaySession, signIn: '/auth/github/start' })
      .replace('<main>', '<main><section class="card-panel" id="relay-notice" role="status"><p>Pairing this browser…</p></section>');
    const banner = "document.querySelector('#relay-notice').hidden";
    stopStandIn = await hostedStandIn(chrome, { anonymous: relayPage(false), relay: relayPage(true) }, await styleOf(view), local);
    const trips = () => chrome.requests.filter((entry) => new URL(entry.url).pathname === '/local/connect').length;
    const relayModule = () => chrome.requests.filter((entry) => entry.url === HOSTED + '/relay/client.js').length;
    /** Wait until the page has asked for the relay module this many times in all. */
    const relayAsked = async (times) => {
      for (const deadline = Date.now() + 10_000; relayModule() < times && Date.now() < deadline;) await new Promise((later) => setTimeout(later, 50)); // budget: hang ceiling for the relay module request.
      assert.equal(relayModule(), times, 'the page loads the relay module');
    };
    const localFetches = "JSON.stringify((window.__localFetches || []).filter((entry) => entry.url.startsWith('http://127.0.0.1:')))";

    // With no view on this machine, the page asks where the projects are: pullboard view here, or sign in for every
    // device (#764). A person with no relay session never loads the relay module, while one with a session gets the
    // relay page. The browser has not been allowed to reach this device yet, so a screen is up before it first asks.
    await view.stop();
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor("location.search === '' && document.querySelector('#local-note')?.dataset.state === 'not-running'", 20_000); // budget: hang ceiling for one refused loopback request.
    const asked = JSON.parse(await chrome.stable(localFetches));
    assert.equal(asked[0]?.url, LOCAL + '/local/protocol', 'the page first reads the public protocol at the default address');
    assert.ok(asked[0].note && ['looking', 'asking'].includes(asked[0].state), `Finding your boards, or Click Allow, is on screen before that request: ${JSON.stringify(asked[0])}`);
    const away = JSON.parse(await chrome.stable("JSON.stringify({ command: document.querySelector('#local-note .ob-two .ob-cmd button').dataset.copy, signIn: document.querySelector('#local-note .ob-two .ob-gh').getAttribute('href') })"));
    assert.deepEqual(away, { command: 'pullboard view', signIn: '/auth/github/start' }, 'nothing running here: the page offers pullboard view and sign-in');
    assert.equal(relayModule(), 0, 'without a relay session the relay module is never loaded');
    assert.equal(await chrome.stable(banner), true, 'and the relay\'s banner does not speak for it');
    await chrome.send('Page.navigate', { url: HOSTED + '/?relay' });
    await chrome.waitFor("location.search === '?relay' && ['blocked', 'not-running', 'no-linked'].includes(document.querySelector('#local-note')?.dataset.state)", 20_000); // budget: hang ceiling for one refused loopback request.
    // A browser that has since refused this page the access is named as the reason, as it is the one the page knows.
    const second = JSON.parse(await chrome.stable(`(async () => JSON.stringify({ state: document.querySelector('#local-note').dataset.state, permission: await navigator.permissions.query({ name: 'loopback-network' }).then((p) => p.state, () => null) }))()`));
    await relayAsked(1);
    // This stand-in serves no relay client, so a signed-in page stays on the screen that waits for this computer.
    assert.ok(second.permission === 'denied' ? second.state === 'blocked' : ['not-running', 'no-linked'].includes(second.state), `the page shows what it knows: ${JSON.stringify(second)}`);
    assert.equal(await chrome.stable("[...document.querySelectorAll('#local-note .ob-gh')].every((link) => link.getClientRects().length === 0)"), true, 'a person with a relay session is not asked to sign in');
    assert.equal(await chrome.stable("document.querySelector('#relay-notice').getClientRects().length"), 0, 'and the screen stands alone, without the relay page\'s banner');
    // A relay pairing link stays the relay's: the page does not look for this machine on that load.
    await chrome.send('Page.navigate', { url: HOSTED + '/#board=b1&key=k1' });
    await relayAsked(2);
    assert.deepEqual(JSON.parse(await chrome.stable(localFetches)), [], 'a pairing load makes no request to the local view');
    // A person who allowed this page to reach this device. One grant refuses every permission it does not name, and
    // the names differ between Chrome versions, so the widest set this Chrome knows is granted at once.
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
    }
    // A view that speaks another protocol is named as not matching this page.
    other = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': HOSTED });
      res.end(JSON.stringify({ version: 2, apiVersion: 2, hostedOrigin: HOSTED }));
    });
    await new Promise((ready) => other.listen(0, '127.0.0.1', ready));
    local.target = 'http://127.0.0.1:' + other.address().port;
    await chrome.send('Page.navigate', { url: HOSTED + '/?other' });
    await chrome.waitFor("location.search === '?other' && document.querySelector('#local-note')?.dataset.state === 'mismatch'", 20_000); // budget: hang ceiling for one loopback request.
    assert.equal(trips(), 0, 'no round trip starts toward a view the page cannot use');

    // This machine's view: the page finds it at the default address, goes round for its secret, and reads the board.
    view = await viewAt(box, port);
    local.target = view.base;
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await showItemChain(chrome, `location.origin === ${JSON.stringify(HOSTED)} && localSession && connection.base === ${JSON.stringify(view.base)}`, 'A board that stays on this machine'); // budget: hang ceiling for the discovery, one top-level round trip and the first board read.
    const shown = JSON.parse(await chrome.stable(`JSON.stringify({ address: location.href, base: connection.base, readOnly, transportModule, kept: sessionStorage.getItem('pullboard.local.session'), lasting: Object.keys(localStorage).map((name) => localStorage.getItem(name)).join(' '), log: window.__localFetches })`));
    assert.ok(!shown.address.includes('pullboard-local') && !shown.address.includes(view.key), 'the secret is gone from the address bar');
    assert.equal(shown.base, view.base, 'the page reads the local view the round trip named');
    assert.equal(shown.readOnly, false, 'the local board is not read-only');
    assert.equal(shown.transportModule, null, 'the relay transport is never loaded');
    assert.equal(await chrome.stable(banner), true, 'and the relay\'s banner is hidden over the local board');
    assert.deepEqual(JSON.parse(shown.kept), { version: 1, origin: view.base, key: view.key }, 'the session is kept for this tab');
    assert.ok(!shown.lasting.includes(view.key), 'nothing lasting holds the secret');
    const atDefault = chrome.requests.map((entry) => entry.url).filter((url) => url.startsWith(LOCAL));
    assert.deepEqual(atDefault.slice(-2), [LOCAL + '/local/protocol', LOCAL + '/local/connect'], 'the page found the view at the default address, then went round to it at the top level');
    const reads = shown.log.filter((entry) => entry.url.startsWith(view.base));
    assert.ok(reads.every((entry) => !entry.address.includes('pullboard-local')), 'no request is made while the secret is in the address');
    assert.ok(reads.some((entry) => entry.url.startsWith(view.base + '/api/')), 'the page reads the board through the view\'s API');
    assert.equal(trips(), 1, 'the page itself started one top-level round trip');
    const api = chrome.requests.filter((entry) => entry.url.startsWith(view.base + '/api/') && entry.method !== 'OPTIONS');
    assert.ok(api.length > 0 && api.every((entry) => Object.entries(entry.headers).some(([name, value]) => name.toLowerCase() === 'x-pullboard-key' && value === view.key)), 'every API request carries the secret in x-pullboard-key');
    assert.ok(chrome.requests.every((entry) => !new URL(entry.url).search.includes(view.key)), 'no request carries the secret in its query');

    // The view restarts with a new secret: the page goes round again by itself.
    const before = view.key;
    await view.stop();
    view = await viewAt(box, port);
    local.target = view.base;
    assert.notEqual(view.key, before, 'the restarted view has a new secret');
    await chrome.waitFor(`connection.headers['x-pullboard-key'] === ${JSON.stringify(view.key)} && document.querySelector('#chain')?.textContent.includes('A board that stays on this machine')`, 45_000); // budget: hang ceiling for the next refresh to meet the refusal, a second round trip and a read.
    assert.equal(trips(), 2, 'the page repeated the round trip without the person');
    assert.ok(!(await chrome.stable('location.href')).includes(view.key), 'the new secret is gone from the address bar too');
    assert.ok(chrome.requests.every((entry) => !new URL(entry.url).search.includes(view.key) && !new URL(entry.url).search.includes(before)), 'neither secret ever rode in a query');
    // A signed-in person with only local boards has no need for the decrypting relay client. The metadata
    // read is on the hosted origin and must never carry this machine's local credential.
    const modulesBefore = relayModule();
    const metadataBefore = chrome.requests.filter((entry) => entry.url === HOSTED + '/api/v1/boards').length;
    await chrome.send('Page.navigate', { url: HOSTED + '/?relay' });
    await showItemChain(chrome, `location.search === '?relay' && localSession && connection.base === ${JSON.stringify(view.base)}`, 'A board that stays on this machine', 20_000); // budget: hang ceiling for a tab-session read and empty linked-board metadata.
    await chrome.waitFor("(window.__localFetches || []).some((entry) => entry.url === '/api/v1/boards')", 10_000); // budget: hang ceiling for the same-origin metadata request.
    assert.equal(await chrome.stable('transportModule'), null, 'an empty linked list leaves the relay transport unloaded even when signed in');
    assert.equal(relayModule(), modulesBefore, 'a local-only signed-in page does not request the relay module');
    const metadata = chrome.requests.filter((entry) => entry.url === HOSTED + '/api/v1/boards').slice(metadataBefore);
    assert.ok(metadata.length > 0, 'the signed-in page checked its linked-board metadata');
    assert.ok(metadata.every((entry) => !Object.keys(entry.headers).some((name) => name.toLowerCase() === 'x-pullboard-key')), 'same-origin metadata never gets the local secret header');
    assert.equal(await chrome.stable('readOnly'), false, 'the local board remains writable');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
    // A local read that fails once, as while the view restarts or is busy, is no reason to load the relay module
    // either: this person's linked list is empty, so the page reads the view again instead (#748).
    const { identifier: failOnce } = await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)} || sessionStorage.getItem('pullboard.test.fail-local-list') !== '1') return;
      sessionStorage.removeItem('pullboard.test.fail-local-list');
      const nextFetch = window.fetch;
      window.fetch = (input, init) => {
        if (!window.__localListFailed && String(typeof input === 'string' ? input : input.url) === ${JSON.stringify(view.base + '/api/v1/boards')}) {
          window.__localListFailed = true;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return nextFetch(input, init);
      };
    })()` });
    assert.equal(await chrome.stable("(() => { sessionStorage.setItem('pullboard.test.fail-local-list', '1'); return true; })()"), true, 'the next load meets one failed local read');
    await chrome.send('Page.navigate', { url: HOSTED + '/?relay' });
    await showItemChain(chrome, `location.search === '?relay' && window.__localListFailed === true && localSession && connection.base === ${JSON.stringify(view.base)}`, 'A board that stays on this machine', 20_000); // budget: hang ceiling for one failed read and the next timed refresh.
    await chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: failOnce });
    assert.equal(relayModule(), modulesBefore, 'a failed local read on a local-only signed-in page does not request the relay module');
    assert.equal(await chrome.stable('transportModule'), null, 'and the relay transport stays unloaded');
    assert.deepEqual(chrome.exceptions, [], 'the failed read is handled: Chrome reports no uncaught exceptions');
  } finally {
    try { if (stopStandIn) await stopStandIn(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { if (other) await new Promise((closed) => { other.close(closed); other.closeAllConnections(); }); }
        finally {
          try { if (view) await view.stop(); }
          finally { rmSync(profile, { recursive: true, force: true }); }
        }
      }
    }
  }
});

/**
 * Register a project under a symlink to its real path, as a machine whose path runs through one does (#937). The
 * registry keeps the spelling it was given, while git reports the real path, so the page sees two spellings.
 */
function registeredUnderSymlink(box, repo) {
  const link = join(box.dir, `linked-${basename(repo)}`);
  symlinkSync(repo, link);
  const file = join(box.dir, 'home', 'projects.json');
  const registry = JSON.parse(readFileSync(file, 'utf8'));
  registry.projects = registry.projects.map((project) => (project.root === repo ? { ...project, root: link } : project));
  writeFileSync(file, JSON.stringify(registry));
  return link;
}

/** The hosted page says how far behind this machine's Pullboard is, for a project at its real or symlinked path (#937). */
async function howFarBehind(t, { linked }) {
  const executable = chromeExecutable();
  assert.ok(executable, 'the hosted version notice needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-release');
  if (linked) registeredUnderSymlink(box, board.repo);
  box.run(board.repo, 'add', 'web', 'A board on an older Pullboard release', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-release-lag-'));
  let view, chrome, stopStandIn;
  try {
    view = await startView(box);
    const local = { own: view.base, target: view.base, versionOverride: '0.8.20' };
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* Chrome versions expose different permission names */ }
    }
    const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
    const versionOrder = (version) => version.split('.').map(Number);
    const compareVersions = (left, right) => {
      const a = versionOrder(left), b = versionOrder(right);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    };
    const releaseVersions = [...new Set([...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\](?:\s|$)/gmu)].map((match) => match[1]))]
      .filter((version) => compareVersions(version, VERSION) <= 0)
      .sort(compareVersions);
    /** Ask the production authenticated relay route to render its default hosted release page. */
    const handler = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
    let productionPage = '';
    let productionHeaders = {};
    const response = { writeHead(_status, headers) { productionHeaders = headers; }, end(content) { productionPage = String(content); } };
    assert.equal(await handler({ method: 'GET', url: '/', headers: {} }, response), true, 'the production relay route serves its authenticated page');
    assert.match(productionHeaders['content-security-policy'], /connect-src[^;]*http:\/\/127\.0\.0\.1:4890[^;]*http:\/\/localhost:4890/u,
      'the production hosted page policy permits its local-view read');
    /** Render the production hosted page for one release target, using only release entries shipped in this package. */
    const pageFor = (version) => cockpitPage('', {
      readOnly: true, requests: true, transportModule: '/relay/client.js', apiHeaders: {}, stylesheet: '/view.css',
      hostedLocal: true, relaySession: true, signIn: '/auth/github/start', hostedReleaseVersion: version, hostedReleaseVersions: releaseVersions,
    }).replace('<main>', '<main><section class="card-panel" id="relay-notice" role="status"><p>Pairing this browser…</p></section>');
    let activePage = pageFor('0.8.21');
    stopStandIn = await hostedStandIn(chrome, { get anonymous() { return activePage; }, get relay() { return activePage; } }, await styleOf(view), local);
    const bannerText = () => chrome.stable("document.querySelector('#hosted-release-text')?.textContent || ''");
    const bannerHidden = () => chrome.stable("document.querySelector('#hosted-release-note')?.hidden ?? true");
    let visit = 0;
    let visitPreload;
    let requestsAt = 0;
    /** Every address one visit asked for, as origin plus path on the hosted page and as origin elsewhere. The page's own
     * record of its fetch calls counts asks a page policy blocks before Chrome's network sees them. */
    const reached = async () => {
      const asked = [...chrome.requests.slice(requestsAt).map((request) => request.url), ...JSON.parse(await chrome.stable('JSON.stringify(window.__releaseFetches || [])'))];
      return [...new Set(asked.map((url) => new URL(url, HOSTED + '/')).filter((address) => address.protocol.startsWith('http'))
        .map((address) => (address.origin === HOSTED ? address.origin + address.pathname : address.origin)))].sort();
    };
    const open = async (version, production = false) => {
      activePage = production ? productionPage : pageFor(version);
      requestsAt = chrome.requests.length;
      if (visitPreload) await chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: visitPreload });
      const marker = ++visit;
      const installed = await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__releaseVisit = ${marker}; window.__releaseFetches = []; const pageFetch = window.fetch; window.fetch = function (input, init) { window.__releaseFetches.push(String(input?.url ?? input)); return pageFetch.call(this, input, init); };` });
      visitPreload = installed.identifier;
      await chrome.send('Page.navigate', { url: HOSTED + '/' });
      await showItemChain(chrome, `window.__releaseVisit === ${marker} && document.readyState === 'complete' && data?.project?.releaseNotes?.version === ${JSON.stringify(local.versionOverride)}`, 'A board on an older Pullboard release', 25_000); // budget: hang ceiling for this navigation to finish the local state read before the next visit; no throughput claim.
    };

    // 0.8.21 is a shipped release in CHANGELOG.md, one actual release after the local 0.8.20 install.
    await open('0.8.21');
    assert.match(await bannerText(), /Pullboard 0\.8\.20 is installed; 0\.8\.21 is current, 1 release behind/u);
    assert.equal(await chrome.stable("document.querySelector('#hosted-release-note code')?.textContent"), 'npm i -g pullboard@latest');
    assert.equal(await chrome.stable("document.querySelector('#hosted-release-link')?.href"), 'https://github.com/pullboard-dev/pullboard/blob/main/CHANGELOG.md');
    await proofShot(chrome, 'hosted-release-note', 1280);
    await proofShot(chrome, 'hosted-release-note', 390);
    await chrome.click("document.querySelector('#hosted-release-dismiss')");
    assert.equal(await bannerHidden(), true, 'dismiss hides the note for its current target release');
    await open('0.8.21');
    assert.equal(await bannerHidden(), true, 'the same target release stays dismissed after reload');

    // The next shipped version gets its own dismissal key and its release count comes from actual release entries.
    await open(VERSION, true);
    const releasesBehind = releaseVersions.indexOf(VERSION) - releaseVersions.indexOf('0.8.20');
    assert.ok(releasesBehind > 0, 'the hosted package has shipped releases after the simulated older install');
    assert.equal(await bannerText(), `Pullboard 0.8.20 is installed; ${VERSION} is current, ${releasesBehind} ${releasesBehind === 1 ? 'release' : 'releases'} behind. Update with`);
    assert.equal(await bannerHidden(), false, 'a new target release brings the note back');
    const behindReached = await reached();

    // The production-generated page counts every numeric release heading, including 0.8.4's section with no headline.
    local.versionOverride = '0.8.4';
    await open(VERSION, true);
    const legacyReleasesBehind = releaseVersions.indexOf(VERSION) - releaseVersions.indexOf('0.8.4');
    assert.ok(legacyReleasesBehind > releasesBehind, 'the full shipped heading list includes releases without headlines');
    assert.equal(await bannerText(), `Pullboard 0.8.4 is installed; ${VERSION} is current, ${legacyReleasesBehind} releases behind. Update with`);

    local.versionOverride = VERSION;
    await open(VERSION, true);
    assert.equal(await bannerHidden(), true, 'matching local and hosted releases show no note');
    assert.deepEqual(behindReached, await reached(), 'the note costs no request: a visit that shows it reaches what a matched visit reaches');
    assert.deepEqual(behindReached.filter((address) => !address.startsWith(HOSTED + '/') && address !== LOCAL && address !== view.base), [],
      'the page learns both versions without asking any other address');

    local.versionOverride = '0.8.22-rc.1';
    await open(VERSION);
    assert.equal(await bannerHidden(), true, 'an unlisted prerelease does not get a guessed release count');
    local.versionOverride = '0.8.23';
    await open('0.8.21');
    assert.equal(await bannerHidden(), true, 'a local version newer than this hosted page does not get a false warning');

    // A mixed list (#632 review): a relay board from another machine beside this machine's own. The selected board's
    // source decides: this machine's board keeps its note while the relay transport is loaded, a relay board shows none.
    const remoteBox = machine();
    const remoteBoard = project(remoteBox, 'remote-a');
    remoteBox.run(remoteBoard.repo, 'add', 'web', 'A board on another machine', '--specs', 'G1');
    const remoteView = await startView(remoteBox);
    try {
      const remoteKey = { headers: { 'x-pullboard-key': remoteView.key } };
      const remoteList = JSON.parse((await call(remoteView, '/api/v1/boards', remoteKey)).body);
      const remote = remoteList.boards[0];
      const remoteState = JSON.parse((await call(remoteView, '/api/v1/boards/' + remote.id + '/state', remoteKey)).body);
      // The relay client stands in with the other machine's real list and state; the page only ever calls request().
      local.client = `export function rememberPairing() { return null; }
export async function createTransport() { return { async request(path) {
  if (path === '/api/v1/boards') return ${JSON.stringify({ ...remoteList, boards: [{ ...remote, name: 'acme/remote-a' }] })};
  if (path.startsWith('/api/v1/boards/${remote.id}/state')) return ${JSON.stringify(remoteState)};
  throw new Error('not in this stand-in: ' + path);
} }; }`;
      local.linked = [{ id: remote.id, repository: 'acme/remote-a', linkedAt: 0 }];
      local.versionOverride = '0.8.20';
      await open(VERSION, true);
      await chrome.waitFor("Boolean(transport) && [...boardSources.values()].map((source) => source.kind).sort().join() === 'local,relay' && document.querySelectorAll('#proj-list .proj.repo').length === 2", 25_000); // budget: hang ceiling for the relay module and its board list after the local read; no throughput claim.
      const roots = JSON.parse(await chrome.stable("JSON.stringify(Object.fromEntries([...boardSources.values()].map((source) => [source.kind, source.board.root])))"));
      // The page's own record of its last switch and its last reads, for the readiness capture (#889).
      await chrome.stable(`(() => {
        const read = api, pick = switchTo;
        window.__journal = { switchedTo: null, reads: [] };
        api = async (path, ...rest) => {
          const entry = { path: String(path).split('?')[0], outcome: 'pending' };
          window.__journal.reads = [...window.__journal.reads, entry].slice(-6);
          try { const reply = await read(path, ...rest); entry.outcome = 'ok'; return reply; }
          catch (error) { entry.outcome = 'failed: ' + String(error.message || error).slice(0, 80); throw error; }
        };
        switchTo = (root, ...rest) => { window.__journal.switchedTo = root; return pick(root, ...rest); };
        return true;
      })()`);
      // A failed wait names the selected root, the sources, the last switch and the last reads, next to the root it
      // expected, so a spelling mismatch, a dropped switch, a late read or a lost read shows which it was (#937, #889).
      const selected = async (root) => {
        try { await chrome.waitFor(`data?.project?.root === ${JSON.stringify(root)} && document.querySelector('#chain')?.textContent.length > 0`, 25_000); } // budget: hang ceiling for one board switch and its state read; no throughput claim.
        catch (error) {
          const reported = await chrome.stable(`JSON.stringify({ selected: data?.project?.root ?? null, viewRoot: view.root, sources: [...boardSources.values()].map((source) => source.kind + ':' + source.board.root), ...window.__journal })`).catch(() => 'unreadable');
          throw new Error(`${error.message}; the page reported ${reported}, expected ${JSON.stringify(root)}`);
        }
      };
      const mixedNote = `Pullboard 0.8.20 is installed; ${VERSION} is current, ${releasesBehind} ${releasesBehind === 1 ? 'release' : 'releases'} behind. Update with`;
      await chrome.stable(`(switchTo(${JSON.stringify(roots.local)}), true)`);
      await selected(roots.local);
      assert.equal(await bannerHidden(), false, 'this machine\'s older board shows its note on a list that also reads relay boards');
      assert.equal(await bannerText(), mixedNote);
      assert.equal(await chrome.stable("document.querySelector('#hosted-release-note code')?.textContent"), 'npm i -g pullboard@latest');
      await chrome.stable(`(switchTo(${JSON.stringify(roots.relay)}), true)`);
      await selected(roots.relay);
      assert.match(await chrome.stable("document.querySelector('#chain')?.textContent"), /A board on another machine/u, 'the relay board is the one on screen');
      assert.equal(await bannerHidden(), true, 'a selected relay board shows no note about this machine\'s install');
      await chrome.stable(`(switchTo(${JSON.stringify(roots.local)}), true)`);
      await selected(roots.local);
      assert.equal(await bannerHidden(), false, 'back on this machine\'s board, the note returns');
      // A read of the chosen board that fails once, as one dropped under load, is read again: the page stays on the
      // board the person chose instead of moving to the other one (#889).
      await chrome.stable(`(switchTo(${JSON.stringify(roots.relay)}), true)`);
      await selected(roots.relay);
      await chrome.stable(`(() => {
        const localId = [...boardSources.values()].find((source) => source.kind === 'local').board.id, read = api;
        let armed = true;
        api = async (path, ...rest) => {
          if (armed && String(path).startsWith('/api/v1/boards/' + encodeURIComponent(localId) + '/state')) { armed = false; throw new Error('a dropped read'); }
          return read(path, ...rest);
        };
        return true;
      })()`);
      await chrome.stable(`(switchTo(${JSON.stringify(roots.local)}), true)`);
      await selected(roots.local);
      assert.equal(await chrome.stable('view.root'), roots.local, 'the page keeps the board the person chose after one failed read');
      assert.equal(await bannerText(), mixedNote);
    } finally {
      local.client = null;
      local.linked = null;
      await remoteView.stop();
    }
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
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
}

test('the hosted page says how far behind this machine\'s Pullboard is [N26,A2]', { timeout: 120_000 }, (t) => howFarBehind(t, { linked: false }));
test('the hosted page shows how far behind a project under a symlinked path is [N26,A2]', { timeout: 120_000 }, (t) => howFarBehind(t, { linked: true }));

test('the hosted relay never treats a remote board version as this machine\'s version [N26,A2]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the relay fallback version guard needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-relay-release');
  box.run(board.repo, 'add', 'web', 'A board read through the relay transport', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-relay-release-'));
  let view, chrome, stopStandIn;
  try {
    view = await startView(box);
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* Chrome versions expose different permission names */ }
    }
    /** The relay page uses an authorized read-only transport backed by this real view's public API. */
    const transportSource = `export async function createTransport() {
      return { async request(path) {
        const response = await fetch(${JSON.stringify(view.base)} + path, { headers: { 'x-pullboard-key': ${JSON.stringify(view.key)} } });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      } };
    }`;
    const handler = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
    let relayPage = '';
    const response = { writeHead() {}, end(content) { relayPage = String(content); } };
    assert.equal(await handler({ method: 'GET', url: '/', headers: {} }, response), true, 'the production relay handler supplies the fallback page');
    stopStandIn = await hostedStandIn(chrome, {
      anonymous: relayPage, relay: relayPage, assets: { '/relay/client.js': transportSource },
    }, await styleOf(view), { own: view.base, target: null, relayTarget: view.base, versionOverride: '0.8.20' });
    const relayVisit = '?relay-release-visit=1';
    await chrome.send('Page.navigate', { url: HOSTED + '/' + relayVisit });
    await showItemChain(chrome, `location.search === ${JSON.stringify(relayVisit)} && document.readyState === 'complete' && data?.project?.releaseNotes?.version === '0.8.20'`, 'A board read through the relay transport', 25_000); // budget: hang ceiling for this navigation to finish the relayed state read; no throughput claim.
    assert.equal(await chrome.stable("data.project.releaseNotes.version"), '0.8.20', 'the relayed API state carries its simulated remote install version');
    assert.equal(await chrome.stable("hosted.local && !localSession && connection.base === '' && !!transport && transportModule === '/relay/client.js' && localConfirmed === false"), true,
      'local discovery failed, so the board remains on the relay transport without a confirmed local session');
    assert.equal(await chrome.stable("document.querySelector('#hosted-release-note').hidden"), true,
      'remote board metadata does not describe this machine’s installed version');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught relay fallback exceptions');
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

test('every hosted page state says what it is and what to do next [N26,H5]', { timeout: 120_000 }, async () => { // budget: hang ceiling for six hosted page loads in Chrome, one with a real round trip.
  const executable = chromeExecutable();
  assert.ok(executable, 'the hosted page check needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-states');
  box.run(board.repo, 'add', 'web', 'A board the hosted page lists', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-hosted-states-'));
  const relay = createRelayBrowserHandler({ authenticate: async () => { if (stand.signedIn) return { kind: 'session' }; throw new Refused('AUTH_REQUIRED', 'Sign in.'); } });
  // What the stand-in answers: the relay's real page and assets, a relay client that has paired no board, the
  // account's linked boards, and this machine's default view address, closed unless the test names a view.
  const stand = { signedIn: false, linked: [], local: null };
  const client = 'export function rememberPairing() { return null; }\nexport async function createTransport() { return { async request(path) { if (path === "/api/v1/boards") return { version: 1, boards: [], warnings: [] }; throw new Error("no paired board"); } }; }\n';
  let view, chrome, listener, old;
  const failures = [];
  try {
    view = await startView(box);
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    listener = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request: asked } = message.params;
      const address = new URL(asked.url);
      const fulfil = (type, body, headers = []) => chrome.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }, ...headers], body: Buffer.from(body).toString('base64') });
      (async () => {
        if (address.origin === LOCAL) {
          if (!stand.local) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
          const reply = await call({ base: stand.local }, address.pathname + address.search, { method: asked.method, headers: Object.fromEntries(Object.entries(asked.headers).filter(([name]) => name.toLowerCase() !== 'host')) });
          return chrome.send('Fetch.fulfillRequest', { requestId, responseCode: reply.status, responseHeaders: Object.entries(reply.headers).filter(([name]) => !['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date'].includes(name)).map(([name, value]) => ({ name, value: String(value) })), body: Buffer.from(reply.body).toString('base64') });
        }
        if (address.pathname === '/relay/client.js') return fulfil('text/javascript', client);
        if (address.pathname === '/api/v1/boards') return fulfil('application/json', JSON.stringify({ version: 1, boards: stand.linked, warnings: [] }));
        let head = {}, body = '';
        const handled = await relay({ method: 'GET', url: address.pathname, headers: {} }, { writeHead: (status, headers) => { head = headers; }, end: (content) => { body = content ?? ''; } });
        if (!handled) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        // The relay's own policy, which also lets the page reach the test view's own port the round trip names.
        const policy = head['content-security-policy'].replace("connect-src 'self'", "connect-src 'self' " + view.base);
        return fulfil(head['content-type'], body, [{ name: 'Content-Security-Policy', value: policy }]);
      })().catch((error) => failures.push(error.message));
    };
    chrome.socket.addEventListener('message', listener);
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }] });
    // A browser that has refused this page its local network permission, as Chrome reports it.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)} || location.search !== '?blocked') return;
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (asked) => ['loopback-network', 'local-network-access'].includes(asked?.name) ? Promise.resolve({ state: 'denied' }) : query(asked);
    })()` });
    const shown = `JSON.stringify((() => {
      const on = (element) => Boolean(element) && !element.hidden && element.getClientRects().length > 0;
      const text = (id) => on(document.getElementById(id)) ? document.getElementById(id).textContent.trim() : null;
      const probe = document.body.appendChild(document.createElement('span'));
      const tokens = ['--accent-strong', '--ink', '--ink-muted', '--surface'].map((token) => { probe.style.color = 'var(' + token + ')'; return getComputedStyle(probe).color; });
      probe.remove();
      return {
        state: document.getElementById('local-note').dataset.state, heading: text('local-note-title'), text: text('local-note-text'), command: text('local-note-code'),
        steps: [...document.querySelectorAll('#local-note a, #local-note button')].filter(on).map((step) => [step.textContent.trim(), step.getAttribute('href')]),
        cards: [...document.querySelectorAll('#local-note .ob-card h2')].filter(on).map((title) => title.textContent),
        side: on(document.querySelector('.side')), banner: on(document.getElementById('relay-notice')), browser: hostedBrowser(navigator),
        defaults: [...document.querySelectorAll('*')].filter((element) => ['rgb(0, 0, 238)', 'rgb(85, 26, 139)'].includes(getComputedStyle(element).color)).map((element) => element.outerHTML.slice(0, 80)),
        bare: [...document.querySelectorAll('a')].filter((link) => on(link) && !link.className && !tokens.includes(getComputedStyle(link).color)).map((link) => link.outerHTML.slice(0, 80)),
      };
    })())`;
    /** Open the hosted page at this address and read the state it settles in. */
    // Every visible control beside a reference of its own kind that sees only the browser's own styles: a control that
    // matches it on appearance, background, border and radius is a native default the view never styled.
    const native = `JSON.stringify((() => {
      const host = document.body.appendChild(document.createElement('div'));
      const root = host.attachShadow({ mode: 'open' });
      const signature = (element) => { const style = getComputedStyle(element); return [style.appearance, style.backgroundColor, style.borderTopStyle, style.borderTopWidth, style.borderRadius].join(' | '); };
      const found = [...document.querySelectorAll('button, input, select, textarea')].filter((element) => element.type !== 'hidden' && element.getClientRects().length > 0).filter((element) => {
        const probe = root.appendChild(document.createElement(element.tagName));
        if (element.type) probe.type = element.type;
        return signature(element) === signature(probe);
      }).map((element) => element.outerHTML.slice(0, 90));
      host.remove();
      return found;
    })())`;
    /** Check every visible control at phone and desktop width, in light and in dark. */
    const styledControls = async (state) => {
      for (const width of [390, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const theme of ['light', 'dark']) {
          await chrome.stable(`document.documentElement.dataset.theme = '${theme}'`);
          assert.deepEqual(JSON.parse(await chrome.stable(native)), [], `${state}: no visible control keeps the browser's native look at ${width}px in ${theme}`);
        }
      }
      await chrome.stable('delete document.documentElement.dataset.theme');
      await chrome.send('Emulation.clearDeviceMetricsOverride');
    };
    const open = async (address, state) => {
      await chrome.send('Page.navigate', { url: HOSTED + '/' + address });
      await chrome.waitFor(`location.search === ${JSON.stringify(address.split('#')[0])} && document.querySelector('#local-note')?.dataset.state === ${JSON.stringify(state)} && !document.querySelector('#local-note').hidden`, 20_000); // budget: hang ceiling for one refused loopback request and an empty relay list.
      const seen = JSON.parse(await chrome.stable(shown));
      await proofShot(chrome, 'hosted-' + state + '-phone', 390);
      await proofShot(chrome, 'hosted-' + state, 1280);
      assert.deepEqual(seen.defaults, [], `${state}: no element keeps the browser's default link colours`);
      assert.deepEqual(seen.bare, [], `${state}: every link has a class or the view's colours`);
      // Each state is one open-board screen (#764): alone, with no sidebar and no Try again; the page looks again by itself.
      assert.equal(seen.side, false, `${state}: the sidebar waits until there is a board to list`);
      assert.ok(!seen.steps.some(([label]) => label === 'Try again'), `${state}: no Try again`);
      await styledControls(state);
      return seen;
    };
    const blocked = await open('?blocked', 'blocked');
    assert.equal(blocked.heading, 'Your browser said no');
    assert.equal(blocked.text, 'That\'s fine. Turn it back on in three clicks:', 'the line leads to the steps that lift the block');
    assert.equal(blocked.browser, 'Chrome', 'the fixture Chrome is named as Chrome');
    assert.deepEqual(blocked.steps.map(([label]) => label), ['', 'Copy'], 'its one control copies the sentence for the agent, beside the theme toggle');

    const absent = await open('?absent', 'not-running');
    assert.equal(absent.heading, 'Where are your projects?');
    assert.deepEqual(absent.cards, ['Open them on this computer', 'Open them from any device'], 'the two ways in, as two cards');
    assert.equal(await chrome.stable("document.querySelector('#local-note .ob-two .ob-cmd button').dataset.copy"), 'pullboard view', 'the command that starts Pullboard here has a copy button');
    assert.equal(absent.banner, false, 'the relay\'s banner stays out of it');

    const out = await open('?out#board=' + 'b'.repeat(32) + '&key=k1', 'signed-out');
    assert.equal(out.heading, 'Open them from any device');
    assert.deepEqual(out.steps.filter(([, href]) => href), [['Sign in with GitHub', '/auth/github/start']], 'the next step is signing in');
    assert.equal(out.banner, false, 'the state speaks for the relay\'s banner');

    stand.signedIn = true;
    const none = await open('?in', 'no-linked');
    assert.equal(none.heading, 'One step on your computer');
    assert.equal(none.command, 'pullboard relay on --all', 'the next step links the boards');
    assert.equal(none.banner, false);
    assert.equal(await chrome.stable("[...document.querySelectorAll('#local-note .ob-gh')].every((link) => link.getClientRects().length === 0)"), true, 'a signed-in person is not asked to sign in');

    stand.linked = [{ id: 'a'.repeat(32), repository: 'acme/web', linkedAt: 0 }];
    const unpaired = await open('?linked', 'unpaired');
    assert.equal(unpaired.heading, 'One step on your computer');
    assert.equal(unpaired.command, 'pullboard relay on --all', 'the next step prints the QR');

    // This machine's view: the normal list, with no state over it.
    stand.signedIn = false;
    stand.linked = [];
    stand.local = view.base;
    // The person allowed this page to reach this device, under whichever permission names this Chrome knows.
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
    }
    // A view from before 0.8.29 refuses the hosted page without the header that would let it read the refusal. The page
    // makes one discovery request of this device (P5), so it reads as no view, and the state's hint names the update.
    old = createServer((req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'this view needs its own address and secret: open the link pullboard view printed' })); });
    await new Promise((ready) => old.listen(0, '127.0.0.1', ready));
    stand.local = 'http://127.0.0.1:' + old.address().port;
    const outdated = await open('?old', 'not-running');
    assert.equal(outdated.heading, 'Where are your projects?', 'a view too old to answer reads as none');
    stand.local = view.base;
    await chrome.send('Page.navigate', { url: HOSTED + '/?list' });
    await showItemChain(chrome, "location.origin === 'https://app.pullboard.dev' && localSession", 'A board the hosted page lists');
    await press(chrome, "document.querySelector('#chain .row')");
    // The opened item's detail is its own round trip after the list (#834): until it lands, #detail says Loading and has no actions.
    try {
      await chrome.waitFor("location.origin === 'https://app.pullboard.dev' && document.querySelector('#chain')?.textContent.includes('A board the hosted page lists') && document.querySelectorAll('#detail button[data-shout], #detail button[data-new]').length === 2", 30_000); // budget: hang ceiling for the discovery, one round trip, the first board read and the opened item's detail.
    } catch (error) {
      // Linux CI only (#873, not reproduced locally): name which part of the condition the page never met.
      try {
        error.message += '; the page showed ' + await chrome.stable(`JSON.stringify({ origin: location.origin, board: (document.querySelector('#chain')?.textContent || '').includes('A board the hosted page lists'),
          buttons: document.querySelectorAll('#detail button[data-shout], #detail button[data-new]').length, detailShown: Boolean(document.querySelector('#detail')?.getClientRects().length),
          detail: (document.querySelector('#detail')?.textContent || '').trim().slice(0, 80), item: view.item ?? null, tab: view.tab ?? null, session: Boolean(localSession), confirmed: localConfirmed,
          note: document.querySelector('#local-note')?.hidden ? null : document.querySelector('#local-note')?.dataset.state ?? null, rows: document.querySelectorAll('#chain .row').length, width: innerWidth })`);
      } catch { /* The original wait failure stays the result. */ }
      throw error;
    }
    const list = JSON.parse(await chrome.stable(`JSON.stringify({ note: document.querySelector('#local-note').hidden, side: document.querySelector('.side').getClientRects().length > 0, heading: document.querySelector('#proj-list .proj.on .pname')?.textContent, source: document.querySelector('#proj-list .proj.on .src')?.textContent, tab: document.querySelector('.tab.on')?.textContent, step: document.querySelector('#new-item').getClientRects().length > 0, state: JSON.parse(${shown}) })`));
    // Normal-list next actions use the view styles at both sizes and in both themes (outside review 950).
    for (const width of [390, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const theme of ['light', 'dark']) {
        await chrome.stable(`document.documentElement.dataset.theme = '${theme}'`);
        const controls = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const probe = document.createElement('button'); probe.textContent = 'UA reference'; document.body.append(probe);
          const signature = (element) => { const style = getComputedStyle(element); return {
            appearance: style.appearance, background: style.backgroundColor, radius: style.borderRadius,
            border: style.borderTopStyle, width: style.borderTopWidth, padding: style.padding,
          }; };
          const baseline = signature(probe);
          const actions = [...document.querySelectorAll('#detail button[data-shout], #detail button[data-new]')]
            .filter((element) => element.getClientRects().length).map((element) => ({ text: element.textContent,
              style: signature(element), height: element.getBoundingClientRect().height }));
          // What the page showed, for a run where the actions do not appear (#829: Linux CI only, not reproduced here).
          const detail = document.querySelector('#detail');
          const seen = { innerWidth, detailShown: Boolean(detail && detail.getClientRects().length), item: view.item ?? null,
            tab: view.tab ?? null, all: [...document.querySelectorAll('#detail button[data-shout], #detail button[data-new]')].map((element) => element.textContent + (element.getClientRects().length ? '' : ' (hidden)')) };
          probe.remove(); return { baseline, actions, seen };
        })())`));
        assert.equal(controls.actions.length, 2, `both next actions appear at ${width}px in ${theme}: ${JSON.stringify(controls.seen)}`);
        for (const action of controls.actions) {
          assert.notDeepEqual(action.style, controls.baseline, `${action.text} uses the view styles at ${width}px in ${theme}`);
          if (width === 390) assert.ok(action.height >= 44, `${action.text} retains a phone touch target in ${theme}`);
        }
      }
      await proofShot(chrome, width === 390 ? 'hosted-list-phone' : 'hosted-list', width);
    }
    await chrome.stable('delete document.documentElement.dataset.theme');
    await styledControls('list');
    assert.deepEqual({ note: list.note, side: list.side }, { note: true, side: true }, 'the list shows with its sidebar and no state over it');
    assert.equal(list.heading, 'hosted-states', 'the sidebar names the board shown');
    assert.equal(list.source, 'this computer', 'with a quiet label for where it comes from');
    assert.equal(list.tab, 'Items', 'its items are open');
    assert.equal(list.step, true, 'and the next step is a new item');
    assert.deepEqual(list.state.defaults, [], 'no element keeps the browser\'s default link colours');
    assert.deepEqual(list.state.bare, [], 'every link has a class or the view\'s colours');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (chrome) { if (listener) chrome.socket.removeEventListener('message', listener); await closeSnapshotChrome(chrome); } }
    finally {
      try { if (old) await new Promise((closed) => { old.close(closed); old.closeAllConnections(); }); }
      finally {
        try { if (view) await view.stop(); }
        finally { rmSync(profile, { recursive: true, force: true }); }
      }
    }
  }
  assert.deepEqual(failures, [], 'the stand-in hosted page was served');
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

test('a phone never waits without a deadline at startup [N26,H5]', { timeout: 90_000 }, async () => { // budget: hang ceiling for two hosted loads in Chrome, one waiting out the 15-second transport deadline.
  const executable = chromeExecutable();
  assert.ok(executable, 'the phone startup check needs real Chrome');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-phone-startup-'));
  const relay = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
  // The relay client fails at once (fail) or never answers (stall); this computer's view is counted and refused.
  const stand = { client: 'fail', local: 0, held: [] };
  let chrome, listener;
  const failures = [];
  try {
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    listener = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request: asked } = message.params;
      const address = new URL(asked.url);
      (async () => {
        if (address.origin === LOCAL) { stand.local += 1; return chrome.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }); }
        if (address.pathname === '/relay/client.js') {
          if (stand.client === 'stall') { stand.held.push(requestId); return; }
          return chrome.send('Fetch.fulfillRequest', { requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: '' });
        }
        let head = {}, body = '';
        const handled = await relay({ method: 'GET', url: address.pathname, headers: {} }, { writeHead: (status, headers) => { head = headers; }, end: (content) => { body = content ?? ''; } });
        if (!handled) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        return chrome.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: Object.entries(head).map(([name, value]) => ({ name, value: String(value) })), body: Buffer.from(body).toString('base64') });
      })().catch((error) => failures.push(error.message));
    };
    chrome.socket.addEventListener('message', listener);
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }] });
    // A phone, as the relay's page tells it (a coarse pointer and no hover), whose local-network permission asks are counted.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)}) return;
      const media = window.matchMedia.bind(window);
      window.matchMedia = (query) => /pointer: coarse|hover: none/.test(query) ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} } : media(query);
      window.__permissionQueries = 0;
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (asked) => { window.__permissionQueries += 1; return query(asked); };
    })()` });
    const shell = `JSON.stringify({ device: document.documentElement.dataset.relayDevice, screen: document.documentElement.dataset.relayScreen,
      line: document.querySelector('#relay-screen .relay-live span')?.textContent ?? null,
      shown: (document.getElementById('relay-screen')?.getClientRects().length ?? 0) > 0, queries: window.__permissionQueries })`;

    // A relay client that fails to load says so in the phone shell, and the page never looked for this computer.
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor("document.querySelector('#relay-screen .relay-live span')?.textContent.includes('Check your connection')", 10_000); // budget: a failed import shows its guidance at once; ceiling for a loaded machine.
    const failed = JSON.parse(await chrome.stable(shell));
    assert.equal(failed.device, 'phone', 'the relay page took this browser for a phone');
    assert.equal(failed.shown, true, 'the phone shell stays on screen');
    assert.match(failed.line, /Failed to fetch dynamically imported module/, 'the shell names the failed load');
    assert.equal(failed.queries, 0, 'a phone never asks for local-network permission');
    assert.equal(stand.local, 0, 'a phone never requests this computer\'s view');

    // A relay client that never answers is bounded: the phone shell says so once its 15-second deadline passes, and
    // only that deadline writes this line, so it is the deadline that ended the wait.
    stand.client = 'stall';
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor("document.querySelector('#relay-screen .relay-live span')?.textContent.includes('did not load within 15 seconds')", 30_000); // budget: the page's 15-second import deadline plus a load ceiling.
    const stalled = JSON.parse(await chrome.stable(shell));
    assert.equal(stalled.shown, true, 'the phone shell stays on screen while the client never answers');
    assert.equal(stalled.queries, 0);
    assert.equal(stand.local, 0);
    assert.ok(stand.held.length > 0, 'the stalled client request really was held');
    assert.deepEqual(failures, []);
  } finally {
    try { if (chrome) { if (listener) chrome.socket.removeEventListener('message', listener); await closeSnapshotChrome(chrome); } }
    finally { rmSync(profile, { recursive: true, force: true }); }
  }
});

test('the page tells its transport when the board drew, and today\'s transport needs nothing [N26,H5]', { timeout: 60_000 }, async () => { // budget: hang ceiling for two hosted loads in Chrome and one relay poll.
  const executable = chromeExecutable();
  assert.ok(executable, 'the render handshake check needs real Chrome');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-render-handshake-'));
  const relay = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
  // A transport that offers didRender (#899's), or today's, which has neither it nor the option; both list no boards.
  const stand = { handshake: true };
  const client = () => 'export function rememberPairing() { return null; }\nexport async function createTransport(options) {\n'
    + '  window.__transportOptions = { waitForRender: options.waitForRender }; window.__drawn = 0; window.__reads = 0;\n'
    + '  return { async request(path) { if (path === "/api/v1/boards") { window.__reads += 1; return { version: 1, boards: [], warnings: [] }; } throw new Error("no paired board"); }'
    + (stand.handshake ? ', didRender() { window.__drawn += 1; }' : '') + ' };\n}\n';
  let chrome, listener;
  const failures = [];
  try {
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    listener = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request: asked } = message.params;
      const address = new URL(asked.url);
      const fulfil = (type, body, headers = []) => chrome.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }, ...headers], body: Buffer.from(body).toString('base64') });
      (async () => {
        if (address.origin === LOCAL) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
        if (address.pathname === '/relay/client.js') return fulfil('text/javascript', client());
        let head = {}, body = '';
        const handled = await relay({ method: 'GET', url: address.pathname, headers: {} }, { writeHead: (status, headers) => { head = headers; }, end: (content) => { body = content ?? ''; } });
        if (!handled) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        return fulfil(head['content-type'], body, Object.entries(head).filter(([name]) => !['content-type', 'cache-control'].includes(name)).map(([name, value]) => ({ name, value: String(value) })));
      })().catch((error) => failures.push(error.message));
    };
    chrome.socket.addEventListener('message', listener);
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }] });
    const drawn = "JSON.stringify({ options: window.__transportOptions ?? null, drawn: window.__drawn ?? null, live: document.getElementById('live').textContent, read: Array.isArray(data?.projects) })";

    // A transport with the handshake is asked to wait for the render, hears once the first board read drew, and again
    // after each later refresh (the relay page polls every 3 seconds).
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor('window.__drawn >= 1', 15_000); // budget: hang ceiling for the first relay read and render on a loaded machine.
    const first = JSON.parse(await chrome.stable(drawn));
    assert.deepEqual(first.options, { waitForRender: true }, 'the page asks the transport to hold until it draws');
    assert.equal(first.read, true, 'the board list was read and drawn');
    await chrome.waitFor('window.__drawn >= 2', 15_000); // budget: hang ceiling for one 3-second relay poll on a loaded machine.

    // Today's transport has neither: the page reads and draws the same, with no error.
    stand.handshake = false;
    const before = chrome.exceptions.length;
    await chrome.send('Page.navigate', { url: HOSTED + '/' });
    await chrome.waitFor("window.__transportOptions && Array.isArray(data?.projects) && !document.getElementById('live').textContent.startsWith('cannot reach')", 15_000); // budget: hang ceiling for the first relay read and render on a loaded machine.
    await chrome.waitFor('window.__reads >= 2', 15_000); // budget: hang ceiling for one 3-second relay poll on a loaded machine, so a refresh ran too.
    const today = JSON.parse(await chrome.stable(drawn));
    assert.equal(today.drawn, 0, 'today\'s transport has no didRender, and nothing calls one');
    assert.doesNotMatch(today.live, /cannot reach|offline/, 'the page did not fail on a transport without the handshake');
    assert.deepEqual(chrome.exceptions.slice(before), [], 'no page exception with today\'s transport');
    assert.deepEqual(failures, []);
  } finally {
    try { if (chrome) { if (listener) chrome.socket.removeEventListener('message', listener); await closeSnapshotChrome(chrome); } }
    finally { rmSync(profile, { recursive: true, force: true }); }
  }
});

test('an item whose detail read is dropped once loads on its own [N26]', { timeout: 90_000 }, async () => { // budget: hang ceiling for one view, one Chrome and a retried read.
  const executable = chromeExecutable();
  assert.ok(executable, 'the detail retry check needs real Chrome');
  const box = machine();
  const board = project(box, 'detail-retry');
  box.run(board.repo, 'add', 'web', 'An item whose first read is dropped', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-detail-retry-'));
  let view, chrome, listener;
  const reads = [];
  try {
    view = await startView(box);
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    // The first read of the item's detail fails at the network, as CI's 'Failed to fetch' did (#908); later ones go through.
    listener = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = message.params;
      reads.push(request.url);
      const send = reads.length === 1 ? chrome.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }) : chrome.send('Fetch.continueRequest', { requestId });
      send.catch(() => { /* the page may have moved on */ });
    };
    chrome.socket.addEventListener('message', listener);
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: view.base + '/api/v1/boards/*/items/1*', requestStage: 'Request' }] });
    const target = new URL('/items/1', view.link);
    target.search = view.link.search;
    await chrome.send('Page.navigate', { url: target.href });
    await chrome.waitFor("document.querySelector('#detail')?.textContent.includes('Could not load #1')", 30_000); // budget: hang ceiling for the first, dropped read.
    await chrome.waitFor("document.querySelectorAll('#detail button[data-shout], #detail button[data-new]').length === 2", 30_000); // budget: hang ceiling for the page's own retry 3 s later.
    assert.ok(reads.length >= 2, 'the page read the item again after the dropped read');
    assert.doesNotMatch(await chrome.stable("document.querySelector('#detail').textContent"), /Could not load/u, 'the failure no longer shows');
  } finally {
    try { if (chrome) { if (listener) chrome.socket.removeEventListener('message', listener); await closeSnapshotChrome(chrome); } }
    finally {
      try { if (view) await view.stop(); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
  }
});

test('a hosted wait that times out names the page state and Chrome\'s network service [N26]', { timeout: 60_000 }, async () => { // budget: hang ceiling for one Chrome and one deliberately failed wait.
  const executable = chromeExecutable();
  assert.ok(executable, 'the named-wait control needs real Chrome');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-named-wait-'));
  let chrome;
  try {
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    // A wait that can never pass: its error must carry what the page showed and Chrome's network-service pids (#908).
    const error = await chrome.waitFor('false', 1_000).then(() => null, (failure) => failure); // budget: hang ceiling for a condition that never holds.
    assert.ok(error, 'the impossible wait failed');  // budget: hang ceiling only; this judges the failure's text, never its timing.
    assert.match(error.message, /; the hosted page showed \{"origin":"[^"]*","search":"[^"]*","note":[^,]*,"rows":\d+,"detail":"[^"]*","relaySession":/u, 'the failure names the page state');  // budget: hang ceiling only; this judges the failure's text, never its timing.
    const marker = '; chrome ';
    assert.ok(error.message.includes(marker), 'the failure carries Chrome health'); // budget: hang ceiling only; this judges diagnostic text, never its timing.
    const health = JSON.parse(error.message.slice(error.message.lastIndexOf(marker) + marker.length));
    assert.deepEqual(Object.keys(health.networkService), ['atStart', 'now'], 'both census observations are named');
    for (const [phase, pids] of Object.entries(health.networkService)) {
      assert.ok(pids === null || Array.isArray(pids) && pids.every(pid => Number.isInteger(pid) && pid > 0),
        `${phase} is an actual PID list or explicitly unknown when the process table cannot be read`);
    }
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { rmSync(profile, { recursive: true, force: true }); }
  }
});

test('a hosted wait census reports unknown when the real process lookup is unavailable [N26]', () => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'pullboard-census-no-ps-'));
  try {
    const module = new URL('./chrome-health.js', import.meta.url).href;
    const code = `import { execFileSync } from 'node:child_process';
      import { networkServicePids } from ${JSON.stringify(module)};
      let code = null;
      try { execFileSync('ps', ['-axo', 'pid=,command=']); } catch (error) { code = error.code; }
      console.log(JSON.stringify({ code, pids: networkServicePids('private-census-control') }));`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, PATH: emptyPath }, encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(result), { code: 'ENOENT', pids: null },
      'an unavailable real ps is reported as unknown, never invented as an empty observed census');
  } finally { rmSync(emptyPath, { recursive: true, force: true }); }
});

test('the hosted page paints no other screen before the one it settles on [N26,H5]', { timeout: 300_000 }, async () => { // budget: hang ceiling for four hosted page loads in Chrome, one holding the relay client for 800 ms.
  const executable = chromeExecutable();
  assert.ok(executable, 'the hosted page check needs real Chrome');
  const box = machine();
  project(box, 'first-frame');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-first-frame-'));
  const relay = createRelayBrowserHandler({ authenticate: async () => { if (stand.signedIn) return { kind: 'session' }; throw new Refused('AUTH_REQUIRED', 'Sign in.'); } });
  // What the stand-in answers for each state: whether the person is signed in, the account's linked boards, this
  // machine's view (closed unless named), and how long the relay client's response is held.
  const stand = { signedIn: false, linked: [], local: null, holdClient: 0 };
  const client = 'export function rememberPairing() { return null; }\nexport async function createTransport() { return { async request(path) { if (path === "/api/v1/boards") return { version: 1, boards: [], warnings: [] }; throw new Error("no paired board"); } }; }\n';
  // Recorded in the page from its first frame: each screen shown, in order, with each change recorded once.
  const recorder = `(() => {
    if (location.origin !== ${JSON.stringify(HOSTED)}) return;
    const shown = (element) => Boolean(element) && getComputedStyle(element).display !== 'none' && element.getClientRects().length > 0;
    const screens = [];
    window.__screens = screens;
    const sample = () => {
      const names = [];
      if (shown(document.querySelector('.hosted-mark'))) names.push('mark');
      if (shown(document.querySelector('.side'))) names.push('side');
      if (shown(document.querySelector('.shell'))) names.push('shell');
      const note = document.querySelector('#local-note');
      if (shown(note)) names.push('note:' + note.dataset.state);
      for (const panel of document.querySelectorAll('#relay-screen .relay-panel')) if (shown(panel)) names.push('panel:' + panel.dataset.screen);
      const now = names.join(' ');
      if (screens.at(-1) !== now) screens.push(now);
    };
    const tick = () => { sample(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`;
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  let view, chrome, listener;
  try {
    view = await startView(box);
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    listener = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request: asked } = message.params;
      const address = new URL(asked.url);
      const fulfil = (type, body, headers = []) => chrome.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }, ...headers], body: Buffer.from(body).toString('base64') });
      (async () => {
        if (address.origin === LOCAL) {
          if (!stand.local) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
          const reply = await call({ base: stand.local }, address.pathname + address.search, { method: asked.method, headers: Object.fromEntries(Object.entries(asked.headers).filter(([name]) => name.toLowerCase() !== 'host')) });
          return chrome.send('Fetch.fulfillRequest', { requestId, responseCode: reply.status, responseHeaders: Object.entries(reply.headers).filter(([name]) => !['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date'].includes(name)).map(([name, value]) => ({ name, value: String(value) })), body: Buffer.from(reply.body).toString('base64') });
        }
        if (address.pathname === '/relay/client.js') { if (stand.holdClient) await pause(stand.holdClient); return fulfil('text/javascript', client); }
        if (address.pathname === '/api/v1/boards') return fulfil('application/json', JSON.stringify({ version: 1, boards: stand.linked, warnings: [] }));
        let head = {}, body = '';
        const handled = await relay({ method: 'GET', url: address.pathname, headers: {} }, { writeHead: (status, headers) => { head = headers; }, end: (content) => { body = content ?? ''; } });
        if (!handled) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        const policy = head['content-security-policy'].replace("connect-src 'self'", "connect-src 'self' " + view.base);
        return fulfil(head['content-type'], body, [{ name: 'Content-Security-Policy', value: policy }]);
      })().catch((error) => { throw error; });
    };
    chrome.socket.addEventListener('message', listener);
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }] });
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: recorder });
    /** Navigate to a state, wait for the real navigation and for the page to settle, then read every screen it showed. */
    const load = async (name, address) => {
      await chrome.send('Page.navigate', { url: HOSTED + '/' + address });
      await chrome.waitFor(`location.origin === ${JSON.stringify(HOSTED)} && document.readyState === 'complete' && document.body && !document.body.classList.contains('loading')`, 60_000); // budget: hang ceiling for one hosted load, including the held relay client.
      await pause(1500);
      const screens = JSON.parse(await chrome.stable('JSON.stringify(window.__screens)'));
      return { name, screens };
    };
    const results = [];
    Object.assign(stand, { signedIn: false, linked: [], local: null, holdClient: 0 });
    results.push(await load('signed out', '?out'));
    Object.assign(stand, { signedIn: true, linked: [], local: null, holdClient: 0 });
    results.push(await load('signed in, nothing shared', '?in'));
    Object.assign(stand, { signedIn: true, linked: [], local: null, holdClient: 800 });
    results.push(await load('signed in, nothing shared, relay client held 800 ms', '?held'));
    Object.assign(stand, { signedIn: true, linked: [], local: view.base, holdClient: 0 });
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
    }
    results.push(await load('signed in, with a board', '?board'));
    for (const { name, screens } of results) {
      assert.equal(screens[0], 'mark', `${name}: the first frame is the neutral mark, not another screen (${JSON.stringify(screens)})`);
      assert.ok(screens.slice(0, -1).every((screen) => screen === 'mark'), `${name}: every frame before the settled screen is the neutral mark (${JSON.stringify(screens)})`);
      assert.notEqual(screens.at(-1), 'mark', `${name}: the page settles on a screen (${JSON.stringify(screens)})`);
      assert.equal(screens.length, 2, `${name}: the settled screen appears once, after the mark (${JSON.stringify(screens)})`);
    }
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
  } finally {
    try { if (chrome) { if (listener) chrome.socket.removeEventListener('message', listener); await closeSnapshotChrome(chrome); } }
    finally {
      try { if (view) await view.stop(); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
  }
});

test('a browser paired here before says it was signed out above this computer\'s boards [N26,H5]', { timeout: 120_000 }, async () => { // budget: hang ceiling for two hosted loads with real round trips in Chrome.
  const executable = chromeExecutable();
  assert.ok(executable, 'the signed-out note needs real Chrome');
  const box = machine();
  const board = project(box, 'signed-out-paired');
  box.run(board.repo, 'add', 'web', 'A board on this computer', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-signed-out-paired-'));
  // Signed out on the relay: its session ended, as when Chrome's cookie jar lost it (#902).
  const relay = createRelayBrowserHandler({ authenticate: async () => { throw new Refused('AUTH_REQUIRED', 'Sign in.'); } });
  let view, chrome, listener;
  const failures = [];
  const failedLoads = new Map(), failedRequests = [];
  try {
    view = await startView(box);
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    listener = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Network.loadingFailed') {
        failedLoads.set(message.params.requestId, { canceled: message.params.canceled === true, errorText: message.params.errorText });
        return;
      }
      if (message.method !== 'Fetch.requestPaused') return;
      const { requestId, request: asked } = message.params;
      const address = new URL(asked.url);
      (async () => {
        if (address.origin === LOCAL) {
          // Let the browser carry method, body and authentication to the real local server. Buffering
          // through call() waits for response end and leaves a live event stream paused indefinitely.
          return chrome.send('Fetch.continueRequest', { requestId, url: view.base + address.pathname + address.search });
        }
        let head = {}, body = '';
        const handled = await relay({ method: 'GET', url: address.pathname, headers: {} }, { writeHead: (status, headers) => { head = headers; }, end: (content) => { body = content ?? ''; } });
        if (!handled) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        const policy = head['content-security-policy'].replace("connect-src 'self'", "connect-src 'self' " + view.base);
        return chrome.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: head['content-type'] }, { name: 'Cache-Control', value: 'no-store' }, { name: 'Content-Security-Policy', value: policy }], body: Buffer.from(body).toString('base64') });
      })().catch((error) => {
        failures.push(error.message);
        failedRequests.push({ networkId: message.params.networkId ?? null, method: asked.method,
          kind: address.pathname.startsWith('/api/') ? 'api' : 'page' });
      });
    };
    chrome.socket.addEventListener('message', listener);
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }] });
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
    }
    // ?paired: this browser keeps a relay board key from an earlier pairing; ?fresh: it never paired.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      if (location.origin !== ${JSON.stringify(HOSTED)}) return;
      if (location.search === '?paired') localStorage.setItem('pullboard.relay.keys.v1', JSON.stringify({ 'b_paired': 'key' }));
      if (location.search === '?fresh') localStorage.removeItem('pullboard.relay.keys.v1');
    })()` });
    const note = "JSON.stringify({ state: document.querySelector('#local-note').hidden ? null : document.querySelector('#local-note').dataset.state, heading: document.getElementById('local-note-title').textContent, text: document.getElementById('local-note-text').textContent, signIn: !document.querySelector('#local-note [data-part=\"github\"]').hidden, board: document.querySelector('#chain')?.textContent.includes('A board on this computer') })";

    await chrome.send('Page.navigate', { url: HOSTED + '/?paired' });
    await showItemChain(chrome, "document.querySelector('#local-note')?.dataset.state === 'signed-out-paired'", 'A board on this computer', 45_000); // budget: hang ceiling for a hosted load with its local round trip.
    const paired = JSON.parse(await chrome.stable(note));
    assert.deepEqual(paired, { state: 'signed-out-paired', heading: 'Signed out of pullboard.dev',
      text: 'Your session here ended, so your shared boards cannot open. Sign in again to see them; the boards on this computer stay open.', signIn: true, board: true });

    await chrome.send('Page.navigate', { url: HOSTED + '/?fresh' });
    await showItemChain(chrome, "location.search === '?fresh' && localSession", 'A board on this computer', 45_000); // budget: hang ceiling for a hosted load with its local round trip.
    const fresh = JSON.parse(await chrome.stable(note));
    assert.notEqual(fresh.state, 'signed-out-paired', 'a browser that never paired here sees only this computer\'s boards');
    assert.deepEqual(failures, [], 'reported network failures: ' + JSON.stringify(failedRequests.map(entry =>
      ({ ...entry, loadingFailed: failedLoads.get(entry.networkId) ?? null }))));
  } finally {
    try { if (chrome) { if (listener) chrome.socket.removeEventListener('message', listener); await closeSnapshotChrome(chrome); } }
    finally {
      try { if (view) await view.stop(); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
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
