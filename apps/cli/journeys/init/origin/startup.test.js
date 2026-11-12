// pullboard: browser
/** @pullboard-test-gui */
/** A phone never waits without a deadline at startup, and the page tells its transport when the board drew [N26,H5]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import {
  machine,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  HOSTED,
  namedWaits,
  LOCAL,
} from './fixture.js';

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
