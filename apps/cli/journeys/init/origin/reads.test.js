// pullboard: browser
/** @pullboard-test-gui */
/** The hosted page reads the local board, and a dropped read or failed wait says what happened [N26,A2]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  createServer,
  request,
} from 'node:http';
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
import { networkServicePids } from '../../../tests/fixtures/cockpit/health.js';
import {
  HOSTED,
  showItemChain,
  namedWaits,
  LOCAL,
  viewAt,
  hostedStandIn,
} from './fixture.js';

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
    // The page as the relay app serves it, with its own banner, which the relay client fills.
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
    const module = new URL('../../../tests/fixtures/cockpit/health.js', import.meta.url).href;
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
