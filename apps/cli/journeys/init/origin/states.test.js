// pullboard: browser
/** @pullboard-test-gui */
/** Every hosted page state says what it is and what to do next [N26,H5]. */
import assert from 'node:assert/strict';
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
import { Refused } from '../../../../../packages/kernel/index.js';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  proofShot,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  HOSTED,
  showItemChain,
  namedWaits,
  LOCAL,
  call,
} from './fixture.js';

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
