// pullboard: browser
/** @pullboard-test-gui */
/** The hosted page paints no other screen before the one it settles on [N26,H5]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refused } from '../../../../../packages/kernel/index.js';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  HOSTED,
  namedWaits,
  LOCAL,
  call,
} from './fixture.js';

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
