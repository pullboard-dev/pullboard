// pullboard: browser
/** @pullboard-test-gui */
/** Opening your board from pullboard.dev: one clear screen at a time, in the approved words, moving on by itself [N26,H5]. */
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
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { createRelayBrowserHandler } from '../../../relay/index.js';
import { RELAY_SCREEN_WORDS } from '../../../relay/index.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  proofShot,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

const HOSTED = 'https://app.pullboard.dev';
const LOCAL = 'http://127.0.0.1:4890';
const NO_JARGON = /local view|relay|linked|try again/i;

/** One plain HTTP request to a view, with exactly these headers, following nothing. */
function call(base, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((done, fail) => {
    const outgoing = request(new URL(path, base), { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on('error', fail);
    outgoing.end();
  });
}

/**
 * Stand in for app.pullboard.dev and this computer's default view address inside one Chrome. Documents come from the
 * relay's real page handler, or, for an address with ?plain, the view's own page without the relay's screens. A
 * request to 127.0.0.1:4890 is refused while no view runs, held while the browser is asking (as Chrome holds it until
 * the person answers), and otherwise passed to the view the test started on its own port.
 */
async function openBoardStand(chrome, view) {
  const stand = { signedIn: false, linked: [], local: null, hold: false, held: [], failures: [], failList: 0, departingDocument: null, failedDocuments: [], dropped: 0 };
  const requestDocuments = new Map();
  const waitingDocuments = new Map();
  /** Attribute an intercepted request to its originating document, regardless of CDP event delivery order. */
  const documentFor = (networkId) => {
    if (requestDocuments.has(networkId)) return Promise.resolve(requestDocuments.get(networkId));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { // budget: hang ceiling for the matching Network event, not a page recovery retry.
        waitingDocuments.delete(networkId);
        reject(new Error('The intercepted board list has no originating document.'));
      }, 5_000);
      waitingDocuments.set(networkId, (document) => { clearTimeout(timer); resolve(document); });
    });
  };
  const client = 'export function rememberPairing() { return null; }\nexport async function createTransport() { return { async request(path) { if (path === "/api/v1/boards") return { version: 1, boards: [], warnings: [] }; throw new Error("no paired board"); } }; }\n';
  const relay = createRelayBrowserHandler({ authenticate: async () => { if (stand.signedIn) return { kind: 'session' }; throw new Refused('AUTH_REQUIRED', 'Sign in.'); } });
  const send = (requestId, status, headers, body) => chrome.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers, body: Buffer.from(body).toString('base64') });
  const fulfil = (requestId, type, body, extra = []) => send(requestId, 200, [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }, ...extra], body);
  /** Answer one request to this computer's default view address from the view the test runs. */
  const toView = async ({ requestId, asked, address }) => {
    if (!stand.local) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
    const reply = await call(stand.local, address.pathname + address.search, { method: asked.method, headers: Object.fromEntries(Object.entries(asked.headers).filter(([name]) => name.toLowerCase() !== 'host')) });
    return send(requestId, reply.status, Object.entries(reply.headers).filter(([name]) => !['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'date'].includes(name)).map(([name, value]) => ({ name, value: String(value) })), reply.body);
  };
  /**
   * Record a reply that failed. A reply that comes after the page stopped waiting, because it moved on, reloaded or its
   * own wait ran out, has nowhere to go: Chrome dropped that request. It is counted, never a failure; any other error
   * still is (#829).
   */
  const settle = (error) => {
    if (/Invalid InterceptionId/u.test(error.message)) stand.dropped += 1;
    else stand.failures.push(error.message);
  };
  const listener = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === 'Network.requestWillBeSent') {
      const { requestId, loaderId, frameId, request: sent } = message.params;
      const target = new URL(sent.url);
      if (sent.method !== 'GET' || target.origin !== view.base || target.pathname !== '/api/v1/boards') return;
      const document = { loaderId, frameId };
      requestDocuments.set(requestId, document);
      waitingDocuments.get(requestId)?.(document);
      waitingDocuments.delete(requestId);
      return;
    }
    if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
      requestDocuments.delete(message.params.requestId);
      return;
    }
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request: asked, networkId } = message.params;
    const address = new URL(asked.url);
    (async () => {
      // The view's own board list, after the round trip: it answers 503 as many times as stand.failList says, as a busy
      // view can, then passes through untouched.
      if (address.origin === view.base) {
        if (stand.failList > 0 && asked.method === 'GET' && address.pathname === '/api/v1/boards') {
          let document, current;
          try {
            document = await documentFor(networkId);
            current = (await chrome.send('Page.getFrameTree')).frameTree.frame;
          }
          catch (error) {
            await chrome.send('Fetch.continueRequest', { requestId });
            throw error;
          }
          if (stand.failList > 0 && document.loaderId !== stand.departingDocument && document.loaderId === current.loaderId && document.frameId === current.id && new URL(current.url).origin === HOSTED) {
            stand.failList -= 1;
            stand.failedDocuments.push(document.loaderId);
            return send(requestId, 503, [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: HOSTED }], JSON.stringify({ error: { code: 'BUSY', message: 'The view is busy.' } }));
          }
        }
        return chrome.send('Fetch.continueRequest', { requestId });
      }
      if (address.origin === LOCAL) {
        if (stand.hold) { stand.held.push({ requestId, asked, address }); return; }
        return toView({ requestId, asked, address });
      }
      if (address.pathname === '/relay/client.js') return fulfil(requestId, 'text/javascript', client);
      if (address.pathname === '/api/v1/boards') return fulfil(requestId, 'application/json', JSON.stringify({ version: 1, boards: stand.linked, warnings: [] }));
      const connect = "connect-src 'self' " + LOCAL + ' http://localhost:4890 ' + view.base;
      if (address.pathname === '/' && address.search.startsWith('?plain')) {
        // A phone, as the relay's page names it before first paint (#757), for the view's own drawing of its screens.
        const page = cockpitPage('', { readOnly: true, requests: stand.signedIn, transportModule: stand.signedIn ? '/relay/client.js' : '/relay/sign-in.js', apiHeaders: {}, stylesheet: '/view.css', hostedLocal: true, relaySession: stand.signedIn, signIn: '/auth/github/start' })
          .replace('</head>', address.search.includes('phone') ? "<script>document.documentElement.dataset.relayDevice = 'phone';</script>\n</head>" : '</head>');
        return fulfil(requestId, 'text/html; charset=utf-8', page, [{ name: 'Content-Security-Policy', value: connect + "; frame-ancestors 'none'" }]);
      }
      let head = {}, body = '';
      const handled = await relay({ method: 'GET', url: address.pathname, headers: {} }, { writeHead: (status, headers) => { head = headers; }, end: (content) => { body = content ?? ''; } });
      if (!handled) return chrome.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      return fulfil(requestId, head['content-type'], body, [{ name: 'Content-Security-Policy', value: head['content-security-policy'].replace("connect-src 'self'", "connect-src 'self' " + view.base) }]);
    })().catch(settle);
  };
  chrome.socket.addEventListener('message', listener);
  await chrome.send('Fetch.enable', { patterns: [{ urlPattern: HOSTED + '/*', requestStage: 'Request' }, { urlPattern: LOCAL + '/*', requestStage: 'Request' }, { urlPattern: view.base + '/api/v1/boards', requestStage: 'Request' }, { urlPattern: view.base + '/api/v1/boards?*', requestStage: 'Request' }] });
  // The browser's answer about local network access, per load: ?asking asks, ?blocked has said no, anything else allows.
  // window.__access changes the answer on an open page, as the person does in the browser's settings. While the browser
  // asks, the discovery request waits as long as the person does, so its timeout never fires on those loads.
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    if (location.origin !== ${JSON.stringify(HOSTED)}) return;
    const search = location.search;
    window.__access = search.startsWith('?asking') ? 'prompt' : search.startsWith('?blocked') ? 'denied' : 'granted';
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (asked) => ['loopback-network', 'local-network-access'].includes(asked?.name) ? Promise.resolve({ state: window.__access }) : query(asked);
    if (search.startsWith('?asking') || search.startsWith('?looking')) AbortSignal.timeout = () => new AbortController().signal;
  })()` });
  // Chrome itself lets the page reach the view's own port, where the round trip sends it; what the page hears of the
  // permission is the override above. Its names differ between Chrome versions, so the widest set this one knows is used.
  // Copy writes with navigator.clipboard, which Chrome answers only for a focused page with clipboard permission. A test
  // Chrome on a busy machine is neither by default: its write can be refused or left waiting past the press, and the
  // button then never reads Copied (tests-63, #764). So the page counts as focused, clipboard access is granted in the
  // same grant, which replaces every earlier one, and each write is recorded with its outcome and how long it took.
  await chrome.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    if (location.origin !== ${JSON.stringify(HOSTED)} || !navigator.clipboard) return;
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.__clipboard = [];
    navigator.clipboard.writeText = (text) => {
      const entry = { text, outcome: 'waiting', started: performance.now() };
      window.__clipboard.push(entry);
      return write(text).then(() => { entry.outcome = 'written'; entry.ms = Math.round(performance.now() - entry.started); }, (error) => { entry.outcome = 'refused: ' + error.message; entry.ms = Math.round(performance.now() - entry.started); throw error; });
    };
  })()` });
  for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess', 'clipboardReadWrite', 'clipboardSanitizedWrite'], ['localNetworkAccess', 'clipboardReadWrite', 'clipboardSanitizedWrite']]) {
    try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* a name this Chrome does not have */ }
  }
  /** Let every held request through, as the person clicking Allow does. */
  stand.release = async () => {
    stand.hold = false;
    const held = stand.held.splice(0);
    for (const entry of held) await toView(entry).catch(settle);
  };
  /** Stop serving the stand-in. */
  stand.stop = async () => {
    chrome.socket.removeEventListener('message', listener);
    await chrome.send('Fetch.disable');
  };
  return stand;
}

// What one open-board screen shows: its state, every visible heading, the words a person reads, what stands around it,
// and the parts the approved screens are made of, with their sizes and colours.
const SHOWN = `JSON.stringify((() => {
  const on = (element) => Boolean(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const all = (selector) => [...document.querySelectorAll(selector)].filter(on);
  const height = (element) => Math.round(element.getBoundingClientRect().height);
  const note = document.getElementById('local-note');
  const copy = (element) => element.querySelector('button')?.dataset.copy ?? null;
  return {
    state: note.dataset.state, shown: on(note),
    headings: all('h1, h2, h3').map((heading) => heading.textContent.trim()),
    say: on(document.getElementById('local-note-text')) ? document.getElementById('local-note-text').textContent.trim() : null,
    text: document.body.innerText,
    around: ['.side', '.top', '.status', '#relay-notice', '.first', '#relay-screen', '#proj-switch', '[data-pane]'].filter((selector) => all(selector).length),
    cards: all('#local-note .ob-card').map((card) => ({ kind: card.querySelector('.ob-k').textContent, title: card.querySelector('h2').textContent, text: card.textContent, width: Math.round(card.getBoundingClientRect().width), height: height(card) })),
    commands: all('#local-note .ob-cmd').map((box) => ({ code: box.querySelector('code').textContent.trim(), copy: copy(box), mono: /mono|Menlo|Consolas/i.test(getComputedStyle(box.querySelector('code')).fontFamily), height: height(box) })),
    agents: all('#local-note .ob-agent').map((box) => ({ text: box.textContent.replace(/Copy$/, '').trim(), copy: copy(box), height: height(box) })),
    help: all('#local-note .ob-help').map((strip) => ({ text: strip.textContent.replace(/Copy$/, '').trim(), copy: copy(strip), border: getComputedStyle(strip).borderTopStyle })),
    helpFit: all('#local-note .ob-help').map((strip) => { const said = strip.querySelector('small'); return { button: height(strip.querySelector('button')), oneLine: said.getBoundingClientRect().height < parseFloat(getComputedStyle(said).fontSize) * 1.8 }; }),
    github: all('#local-note .ob-gh').map((button) => ({ text: button.textContent.trim(), href: button.getAttribute('href'), height: height(button), background: getComputedStyle(button).backgroundColor })),
    live: all('#local-note .ob-live').map((line) => line.textContent.trim()),
    ask: all('#local-note .ob-ask').map((bubble) => bubble.textContent.replace(/\\s+/g, ' ').trim()),
    steps: all('#local-note .ob-steps li').map((step) => step.textContent.trim()),
    small: all('#local-note .ob-small').map((line) => line.textContent.trim()),
    spin: all('#local-note .ob-spin').length,
    theme: on(document.getElementById('ob-theme')) && Boolean(document.getElementById('ob-theme').closest('header')),
    controls: all('button, a').map((control) => control.textContent.trim()),
  };
})())`;

/**
 * Press one Copy button as a person does, then see it say Copied and the clipboard hold its words. If it never says
 * Copied, the failure names what the button says and what each clipboard write did, so a slow or refused write shows.
 */
async function pressCopy(chrome, button, words) {
  await press(chrome, `document.querySelector(${JSON.stringify(button)})`);
  try {
    await chrome.waitFor(`document.querySelector(${JSON.stringify(button)}).textContent === 'Copied'`, 5_000); // budget: hang ceiling for one granted clipboard write.
  } catch (error) {
    const seen = await chrome.stable(`JSON.stringify({ label: document.querySelector(${JSON.stringify(button)})?.textContent, writes: window.__clipboard ?? null, focused: document.hasFocus() })`);
    throw new Error(`${error.message}; the button and clipboard show ${seen}`, { cause: error });
  }
  assert.equal(await chrome.stable('navigator.clipboard.readText()'), words, `${button}: the clipboard holds the words the button copies`);
}

/** Open the stand-in page at this address, wait for the open-board state it should settle in, and read it. */
async function openState(chrome, address, state, shot) {
  await chrome.send('Page.navigate', { url: HOSTED + '/' + address });
  await chrome.waitFor(`location.search === ${JSON.stringify(address.split('#')[0])} && document.querySelector('#local-note')?.dataset.state === ${JSON.stringify(state)} && !document.querySelector('#local-note').hidden && document.querySelector('#local-note').getClientRects().length > 0`, 20_000); // budget: hang ceiling for one page load and one refused or held loopback request.
  const seen = JSON.parse(await chrome.stable(SHOWN));
  if (shot) {
    await proofShot(chrome, shot + '-phone', 390);
    await proofShot(chrome, shot, 1280);
  }
  return seen;
}

/** Open the Items tab with one plain click, as a person would, since the list is only drawn there. */
async function openItems(chrome) {
  for (let attempt = 0; ; attempt++) {
    try {
      await chrome.waitFor("!!document.querySelector('[data-tab=\"items\"]')", 30_000); // budget: hang ceiling for a page that is still loading.
      return await press(chrome, "document.querySelector('[data-tab=\"items\"]')", { native: false });
    } catch (error) {
      if (attempt >= 4 || !/navigated or closed/.test(String(error?.message ?? error))) throw error; // a page mid-navigation is retried once it settles.
    }
  }
}

/** The checks every open-board screen passes: shown alone, one heading, no Try again and none of the old jargon. */
function alone(seen, heading, { allow = '' } = {}) {
  assert.equal(seen.shown, true, `${seen.state}: the screen shows`);
  assert.deepEqual(seen.headings.filter((text) => !seen.cards.some((card) => card.title === text)), [heading], `${seen.state}: one heading, never stacked with another`);
  assert.deepEqual(seen.around, [], `${seen.state}: no sidebar, Projects header, tabs, status line, banner or board stands beside it`);
  assert.doesNotMatch(allow ? seen.text.split(allow).join('') : seen.text, NO_JARGON, `${seen.state}: no Try again, local view, relay or linked in the words a person reads`);
  assert.ok(!seen.controls.includes('Try again'), `${seen.state}: no Try again button`);
  assert.equal(seen.theme, true, `${seen.state}: the theme toggle sits in the header`);
}

test('each open-board state shows alone with its words [N26,H5]', { timeout: 150_000 }, async () => { // budget: hang ceiling for nine hosted page loads in Chrome with screenshots at two widths.
  const executable = chromeExecutable();
  assert.ok(executable, 'the open-board check needs real Chrome');
  const box = machine();
  project(box, 'open-board-states');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-open-board-'));
  let view, chrome, stand, other;
  try {
    view = await startView(box);
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    stand = await openBoardStand(chrome, view);
    // A computer's window, wide enough for the two cards to stand side by side.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    // Finding your boards: the page looks on this computer, and the answer has not come yet.
    stand.hold = true;
    const looking = await openState(chrome, '?looking', 'looking', 'open-board-looking');
    alone(looking, 'Finding your boards…');
    assert.equal(looking.spin, 1, 'a spinner turns while it looks');
    assert.deepEqual([looking.say, looking.commands, looking.github, looking.help], [null, [], [], []], 'and there is nothing to do yet');
    await stand.release();

    // Click Allow: the browser asks, the page draws its prompt and waits for the person.
    stand.hold = true;
    const asking = await openState(chrome, '?asking', 'asking', 'open-board-asking');
    alone(asking, 'Click Allow');
    assert.equal(asking.say, 'Your browser is asking if this page may open the boards on this computer. Your boards stay on this computer.');
    assert.equal(asking.ask.length, 1, 'the browser\'s prompt is drawn');
    assert.match(asking.ask[0], /^app\.pullboard\.dev wants to Access other apps and services on this device Block Allow ↑ click this$/, 'with its words and the button to click');
    assert.deepEqual(asking.live, ['Waiting for you to click Allow'], 'a live line says the page waits');
    assert.deepEqual(asking.help, [{ text: 'Something not working? Ask your agent“Help me allow Pullboard in my browser.”', copy: 'Help me allow Pullboard in my browser.', border: 'dashed' }], 'a dashed help strip ends the screen with a sentence to copy');
    assert.deepEqual(asking.helpFit, [{ button: 40, oneLine: true }], 'its Copy is the 40 px button the mockup draws, and on a computer the sentence keeps to one line');
    await pressCopy(chrome, '#local-note .ob-help button', 'Help me allow Pullboard in my browser.');
    // The theme toggle in the header turns the page to the other scheme.
    const before = await chrome.stable('document.documentElement.dataset.scheme');
    await press(chrome, "document.getElementById('ob-theme')");
    assert.equal(await chrome.stable('document.documentElement.dataset.scheme'), before === 'dark' ? 'light' : 'dark', 'the header\'s toggle changes the theme');
    await chrome.stable("(() => { localStorage.removeItem('pb.theme'); return true; })()");
    stand.held.splice(0);
    stand.hold = false;

    // Your browser said no: three steps, then the page carries on by itself.
    const blocked = await openState(chrome, '?blocked', 'blocked', 'open-board-blocked');
    alone(blocked, 'Your browser said no');
    assert.equal(blocked.say, 'That\'s fine. Turn it back on in three clicks:');
    assert.deepEqual(blocked.steps, ['Click the icon left of the address, at the top of this window.', 'Find Local network access, or Apps on this device.', 'Set it to Allow.'], 'three steps');
    assert.deepEqual(blocked.live, ['Your boards open as soon as it\'s on']);
    assert.deepEqual(blocked.help, [{ text: 'Something not working? Ask your agent“My browser blocked Pullboard. Help me fix it.”', copy: 'My browser blocked Pullboard. Help me fix it.', border: 'dashed' }]);
    assert.deepEqual(blocked.helpFit, [{ button: 40, oneLine: true }], 'the sentence keeps to one line');

    // Where are your projects: nothing runs here and nobody is signed in, so two equal cards say how the paths differ.
    const absent = await openState(chrome, '?absent', 'not-running', 'open-board-where');
    alone(absent, 'Where are your projects?');
    assert.deepEqual(absent.cards.map((card) => [card.kind, card.title]), [['Local only', 'Open them on this computer'], ['Everywhere', 'Open them from any device']], 'the two cards, local only first');
    assert.match(absent.cards[0].text, /Your boards stay on this computer, and only this computer sees them\. Open a terminal and run:/);
    assert.match(absent.cards[0].text, /Either way, this page opens your boards by itself\./);
    assert.match(absent.cards[1].text, /Your boards on your phone and every computer, from the GitHub account you shared them with\./);
    assert.match(absent.cards[1].text, /Not shared yet\? After you sign in, it shows the one step\./);
    assert.ok(Math.abs(absent.cards[0].width - absent.cards[1].width) <= 1 && Math.abs(absent.cards[0].height - absent.cards[1].height) <= 1, `the cards are equal: ${JSON.stringify(absent.cards.map((card) => [card.width, card.height]))}`);
    assert.deepEqual(absent.commands, [{ code: '$pullboard view', copy: 'pullboard view', mono: true, height: 60 }], 'pullboard view in a mono box with a Copy button');
    assert.deepEqual(absent.agents, [{ text: 'Ask your agent“Help me open my Pullboard board.”', copy: 'Help me open my Pullboard board.', height: 60 }], 'its "or" box asks the agent, at the same height');
    assert.deepEqual(absent.github, [{ text: 'Sign in with GitHub', href: '/auth/github/start', height: 60, background: 'rgb(31, 35, 40)' }], 'one dark 60 px GitHub button');
    assert.deepEqual(absent.live, ['Still looking on this computer'], 'a live line says the page keeps looking');
    // A request waiting for the person on this device, as apps/relay/src/io/deploy/browser-devices.js puts in the page, is never hidden
    // behind a screen: it stays where they can answer it.
    assert.equal(await chrome.stable("(() => { const panel = document.createElement('section'); panel.id = 'phone-approvals'; panel.className = 'card-panel'; panel.textContent = 'Link notes from this device?'; document.querySelector('main').prepend(panel); const shown = panel.getClientRects().length > 0; panel.remove(); return shown; })()"), true, 'a waiting request on this device shows beside the screen');
    await pressCopy(chrome, '#local-note .ob-cmd button', 'pullboard view');

    // Pullboard on this computer speaks another version of the page's protocol: one command updates it, and a dashed
    // strip ends the screen, as on every screen where something can go wrong.
    other = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': HOSTED });
      res.end(JSON.stringify({ version: 2, apiVersion: 2, hostedOrigin: HOSTED }));
    });
    await new Promise((ready) => other.listen(0, '127.0.0.1', ready));
    stand.local = 'http://127.0.0.1:' + other.address().port;
    const update = await openState(chrome, '?mismatch', 'mismatch', 'open-board-update');
    alone(update, 'Update Pullboard on this computer');
    assert.deepEqual(update.commands.map((command) => [command.code, command.copy, command.height]), [['$npm i -g pullboard', 'npm i -g pullboard', 60]], 'the update command in a mono box with Copy');
    assert.deepEqual(update.agents.map((agent) => [agent.text, agent.copy, agent.height]), [['Ask your agent“Help me update Pullboard.”', 'Help me update Pullboard.', 60]], 'its "or" box asks the agent to help update');
    assert.deepEqual(update.help, [{ text: 'Something not working? Ask your agent“Help me update Pullboard.”', copy: 'Help me update Pullboard.', border: 'dashed' }], 'a dashed help strip with a sentence to copy ends the screen');
    assert.deepEqual(update.helpFit, [{ button: 40, oneLine: true }]);
    await pressCopy(chrome, '#local-note .ob-help button', 'Help me update Pullboard.');
    stand.local = null;

    // A pairing link on a computer, not signed in: the one way that opens boards from any device.
    const out = await openState(chrome, '?out#board=' + 'b'.repeat(32) + '&key=k1', 'signed-out', 'open-board-sign-in');
    alone(out, 'Open them from any device');
    assert.deepEqual(out.github.map((button) => [button.text, button.href, button.height]), [['Sign in with GitHub', '/auth/github/start', 60]]);
    assert.deepEqual(out.help, [{ text: 'Something not working? Ask your agent“Help me open my Pullboard board.”', copy: 'Help me open my Pullboard board.', border: 'dashed' }], 'a dashed help strip with a sentence to copy ends the screen');
    assert.deepEqual(out.helpFit, [{ button: 40, oneLine: true }]);
    await pressCopy(chrome, '#local-note .ob-help button', 'Help me open my Pullboard board.');

    // The phone's first screen, drawn by the view from the state #757 provides: one GitHub button, nothing about this computer.
    const phone = await openState(chrome, '?plain-phone#board=' + 'b'.repeat(32) + '&key=k1', 'signed-out', 'open-board-phone');
    const words = RELAY_SCREEN_WORDS;
    alone(phone, words.signIn.title);
    assert.equal(phone.say, words.signIn.say);
    assert.deepEqual(phone.github.map((button) => [button.text, button.height, button.background]), [[words.signIn.action, 60, 'rgb(31, 35, 40)']], 'one dark GitHub button');
    assert.deepEqual(phone.small, [words.signIn.small]);
    assert.deepEqual(phone.help.map((strip) => [strip.text, strip.copy, strip.border]), [[words.signIn.help + '“' + words.signIn.ask + '”', words.signIn.ask, 'dashed']]);
    assert.doesNotMatch(phone.text, /this computer|pullboard view/i, 'a phone hears nothing about this computer or pullboard view');

    // Signed in with nothing shared: the one step on the computer with the projects, and a live waiting line.
    stand.signedIn = true;
    const share = await openState(chrome, '?in', 'no-linked', 'open-board-share');
    alone(share, words.share.title, { allow: words.share.command });
    assert.equal(share.say, words.share.say);
    assert.deepEqual(share.commands.map((command) => [command.code, command.copy, command.height]), [['$' + words.share.command, words.share.command, 60]]);
    assert.deepEqual(share.agents.map((agent) => [agent.text, agent.copy, agent.height]), [[words.share.agent + '“' + words.share.ask + '”', words.share.ask, 60]]);
    assert.deepEqual(share.small, [words.share.small]);
    assert.deepEqual(share.live, [words.share.waiting]);

    // Signed in, and the account shares a board this browser holds no key for. Running the command alone never opens
    // it here: a browser enrolls only from the pairing link the command prints, so the screen says to open that link
    // or scan its QR, and never that the boards show up by themselves. Nobody waits forever.
    stand.linked = [{ id: 'a'.repeat(32), repository: 'acme/web', linkedAt: 0 }];
    const unpaired = await openState(chrome, '?linked', 'unpaired', 'open-board-unpaired');
    alone(unpaired, words.share.title, { allow: words.share.command });
    assert.equal(unpaired.say, 'On the computer with your projects, open a terminal and run this, then open the link it prints here or scan its QR:', 'the step names the link and the QR');
    assert.deepEqual(unpaired.commands.map((command) => [command.code, command.copy]), [['$' + words.share.command, words.share.command]]);
    assert.deepEqual(unpaired.small, ['Your account shares acme/web. This browser opens it from that link.'], 'it names the shared board and how this browser opens it');
    assert.doesNotMatch(unpaired.text, /by themselves/, 'and never says the boards arrive by themselves');
    assert.deepEqual(unpaired.live, [words.share.waiting]);
    stand.linked = [];
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
    assert.deepEqual(stand.failures, [], 'the stand-in hosted page was served');
  } finally {
    try { if (stand) await stand.stop(); }
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

test('the page moves on by itself when the view starts [N26,H5]', { timeout: 120_000 }, async () => { // budget: hang ceiling for two hosted loads, a view start, a round trip and the first board reads.
  const executable = chromeExecutable();
  assert.ok(executable, 'the open-board check needs real Chrome');
  const box = machine();
  const board = project(box, 'open-board-moves');
  await box.inProcess(board.repo, 'add', 'web', 'A board that opens by itself', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-open-board-moves-'));
  let view, chrome, stand;
  try {
    // A view runs only to give the stand-in its address; the page cannot reach it until the test says so.
    view = await startView(box);
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    stand = await openBoardStand(chrome, view);
    // Count every press and click, so the move is shown to need none.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: "(() => { window.__clicks = 0; addEventListener('pointerdown', () => { window.__clicks += 1; }, true); addEventListener('click', () => { window.__clicks += 1; }, true); })()" });
    // Every state the screen passes through on a load, so a screen that came and went is on the record.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__states = [];
      const appearing = new MutationObserver(() => {
        const note = document.getElementById('local-note');
        if (!note) return;
        appearing.disconnect();
        window.__states.push(note.dataset.state);
        new MutationObserver(() => window.__states.push(note.dataset.state)).observe(note, { attributes: true, attributeFilter: ['data-state'] });
      });
      appearing.observe(document, { childList: true, subtree: true });
    })()` });
    const opened = "location.origin === 'https://app.pullboard.dev' && document.querySelector('#chain')?.textContent.includes('A board that opens by itself')";

    // Nothing runs here: Where are your projects?, with its live line. Then the view starts, and the board opens.
    const absent = await openState(chrome, '?absent', 'not-running');
    assert.deepEqual(absent.live, ['Still looking on this computer']);
    assert.ok(!absent.controls.includes('Try again'), 'there is no Try again to press');
    stand.local = view.base;
    await openItems(chrome); // the one click: pages open on the Dashboard, and the list is drawn on Items.
    await chrome.waitFor(opened, 30_000); // budget: hang ceiling for the next re-check, one round trip and the first board read.
    const shown = JSON.parse(await chrome.stable("JSON.stringify({ note: document.getElementById('local-note').hidden, side: document.querySelector('.side').getClientRects().length > 0, clicks: window.__clicks })"));
    assert.deepEqual(shown, { note: true, side: true, clicks: 1 }, 'the board shows with its sidebar, the open-board screen gone, and only the Items click was made');

    // The browser asks: the discovery waits, as Chrome holds it, and the page says so. The person allows it, and the
    // board opens with no click on the page.
    stand.hold = true;
    await chrome.stable("(() => { sessionStorage.clear(); return true; })()");
    const asking = await openState(chrome, '?asking', 'asking');
    assert.deepEqual(asking.live, ['Waiting for you to click Allow']);
    await chrome.stable("(() => { window.__access = 'granted'; return true; })()");
    await stand.release();
    await openItems(chrome);
    await chrome.waitFor(opened, 30_000); // budget: hang ceiling for the released discovery and the first board read.
    assert.equal(await chrome.stable('window.__clicks'), 1, 'only the Items click was made on the page');

    // The browser said no: once the person turns access back on, the page carries on by itself.
    await chrome.stable("(() => { sessionStorage.clear(); return true; })()");
    await openState(chrome, '?blocked', 'blocked');
    await chrome.stable("(() => { window.__access = 'granted'; return true; })()");
    await openItems(chrome);
    await chrome.waitFor(opened, 30_000); // budget: hang ceiling for the next re-check and the first board read.
    assert.equal(await chrome.stable('window.__clicks'), 1, 'only the Items click was made on the page');

    // The view answers, but its first board list fails once with a 503, as a busy view can, and the next one succeeds:
    // the problem screen it met gives way to the board by itself, with the sidebar back, and nobody clicks.
    await chrome.stable("(() => { sessionStorage.clear(); return true; })()");
    const departingTime = await chrome.stable('performance.timeOrigin');
    stand.departingDocument = (await chrome.send('Page.getFrameTree')).frameTree.frame.loaderId;
    stand.failList = 1;
    // Exercise the departing page's real refresh in the vulnerable interval: its request must not spend the next
    // document's failure. The same interval used to depend on the periodic refresh happening to fire under load.
    await chrome.stable('refresh().then(() => true, () => true)');
    await chrome.send('Page.navigate', { url: HOSTED + '/?recover' });
    try {
      await openItems(chrome);
      await chrome.waitFor('performance.timeOrigin !== ' + departingTime + ' && ' + opened + " && document.getElementById('local-note').hidden && !document.body.classList.contains('open-board')", 30_000); // budget: hang ceiling for one round trip, the failed list, a re-read two seconds on and the first board read.
    } catch (error) {
      const page = await chrome.stable("JSON.stringify({ href: location.href, states: window.__states, state: document.getElementById('local-note')?.dataset.state, hidden: document.getElementById('local-note')?.hidden, board: document.querySelector('#chain')?.textContent.slice(0, 120) })").catch((failure) => failure.message);
      throw new Error(`${error.message}; recovery diagnostic ${JSON.stringify({ page, failedDocuments: stand.failedDocuments, remainingFailures: stand.failList, failures: stand.failures })}`, { cause: error });
    }
    assert.equal(stand.failList, 0, 'the first board list met a 503');
    const recoveredDocument = (await chrome.send('Page.getFrameTree')).frameTree.frame.loaderId;
    assert.deepEqual(stand.failedDocuments, [recoveredDocument], 'the recovering document, not the departing page, met the 503');
    const recovered = JSON.parse(await chrome.stable("JSON.stringify({ states: window.__states, state: document.getElementById('local-note').dataset.state, side: document.querySelector('.side').getClientRects().length > 0, clicks: window.__clicks })"));
    assert.ok(recovered.states.includes('problem'), `the failed list showed the problem screen first: ${JSON.stringify(recovered.states)}`);
    assert.deepEqual({ state: recovered.state, side: recovered.side, clicks: recovered.clicks }, { state: '', side: true, clicks: 1 }, 'then the board shows, the problem screen gone and the sidebar back, and only the Items click was made');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught exceptions');
    assert.deepEqual(stand.failures, [], 'the stand-in hosted page was served');
  } finally {
    try { if (stand) await stand.stop(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { if (view) await view.stop(); }
        finally { rmSync(profile, { recursive: true, force: true }); }
      }
    }
  }
});


test('the link invitation closes, stays closed and comes back [N26,H5]', async t => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome for the real link invitation check.');
  const box = machine();
  const demo = project(box, 'link-invitation');
  await box.inProcess(demo.repo, 'milestone', 'add', 'Delivery');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-link-invitation-'));
  let view; let chrome; let available = true;
  const failures = [];
  try {
    view = await startView(box);
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    // Only availability is supplied; the board, rendering, storage and all clicks are real.
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method !== 'Fetch.requestPaused') return;
      chrome.send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ version: 1, available })).toString('base64') }).catch(error => failures.push(error.message));
    });
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: view.base + '/api/v1/view-link', requestStage: 'Request' }] });
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor("data?.project?.root && !document.body.classList.contains('loading')");
    await chrome.stable('sharingReady');
    await openItems(chrome); // the first-run Dashboard hides the card, so a person opens Items first.
    assert.equal(await chrome.stable("document.querySelector('#share-note b')?.textContent"), 'Open your boards on any device');
    assert.equal(await chrome.stable("document.querySelector('#share-note .share-txt > span')?.textContent"), 'Sign in to use pullboard.dev while on the go.');
    assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify((() => { const a = document.querySelector('#share-note .share-txt a'); return a ? [a.textContent, a.href, a.target, a.rel] : null; })())")), ['How the relay works', 'https://pullboard.dev/relay/', '_blank', 'noopener']);
    assert.equal(await chrome.stable("document.querySelector('#share-start').textContent.trim()"), 'Sign in with GitHub');
    assert.equal(await chrome.stable("Boolean(document.querySelector('#share-start svg') && document.querySelector('#share-note .share-ic svg'))"), true);
    assert.equal(await chrome.stable("document.querySelector('#share-hide')?.getAttribute('aria-label')"), 'Hide this; bring it back from the projects list');
    assert.equal(await chrome.stable("document.querySelector('#share-again')?.hidden"), true, 'no redundant entry while the card shows');
    await press(chrome, "document.querySelector('#share-hide')");
    assert.equal(await chrome.stable("document.querySelector('#share-note').hidden"), true);
    assert.equal(await chrome.stable("document.querySelector('#share-again').hidden"), false);
    await chrome.send('Page.reload');
    await chrome.waitFor("data?.project?.root && !document.body.classList.contains('loading')");
    await chrome.stable('sharingReady');
    await openItems(chrome); // the first-run Dashboard hides the card, so a person opens Items first.
    assert.equal(await chrome.stable("document.querySelector('#share-note').hidden"), true, 'the machine remembers dismissal after reload');
    assert.equal(await chrome.stable("document.querySelector('#share-again').textContent"), 'Link boards to pullboard.dev…');
    await press(chrome, "document.querySelector('#share-again')");
    assert.equal(await chrome.stable("document.querySelector('#share-note').hidden"), false);
    assert.equal(await chrome.stable("document.querySelector('#share-again').hidden"), true);
    const backgrounds = new Set();
    for (const width of [1280, 390, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      await chrome.waitFor("document.querySelector('.roadmap-list') && document.querySelector('.roadmap-panel')");
      for (const theme of ['light', 'dark']) {
        await chrome.stable(`document.documentElement.dataset.theme = '${theme}'`);
        const measured = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const card = document.querySelector('#share-note'), rect = card.getBoundingClientRect();
          const parts = [...document.querySelectorAll('.roadmap-list, .roadmap-panel')].map(part => part.getBoundingClientRect());
          const button = document.querySelector('#share-start');
          const link = card.querySelector('.share-txt a'), line = card.querySelector('.share-txt > span'), linkRect = link.getBoundingClientRect();
          return { left: rect.left, right: rect.right, columnsLeft: Math.min(...parts.map(part => part.left)),
            columnsRight: Math.max(...parts.map(part => part.right)), background: getComputedStyle(card).backgroundColor,
            githubBackground: getComputedStyle(button).backgroundColor, overflow: document.documentElement.scrollWidth > innerWidth,
            buttonFits: button.getBoundingClientRect().right <= rect.right,
            linkFits: linkRect.left >= rect.left && linkRect.right <= rect.right,
            linkBelowLine: linkRect.top >= line.getBoundingClientRect().bottom - 1,
            linkColor: getComputedStyle(link).color, entryColor: getComputedStyle(document.querySelector('#share-again')).color,
            closeWidth: document.querySelector('#share-hide').getBoundingClientRect().width,
            closeHeight: document.querySelector('#share-hide').getBoundingClientRect().height,
            buttonHeight: button.getBoundingClientRect().height };
        })())`));
        assert.ok(Math.abs(measured.left - measured.columnsLeft) < 1 && Math.abs(measured.right - measured.columnsRight) < 1,
          `${width}/${theme}: the full card spans both Roadmap and Releases columns`);
        assert.equal(measured.githubBackground, 'rgb(31, 35, 40)', 'the existing GitHub style stays dark');
        assert.equal(measured.overflow, false, `${width}/${theme}: no horizontal overflow`);
        assert.equal(measured.buttonFits, true);
        assert.equal(measured.linkFits, true, `${width}/${theme}: the relay link stays inside the card`);
        assert.equal(measured.linkColor, measured.entryColor, `${width}/${theme}: the relay link uses the view accent`);
        if (width < 600) assert.equal(measured.linkBelowLine, true, `${width}/${theme}: the relay link wraps below the quiet line`);
        const target = width < 900 ? 44 : 32;
        assert.ok(measured.closeWidth >= target && measured.closeHeight >= target && measured.buttonHeight >= target,
          `${width}/${theme}: close and sign-in retain the view's existing tap target`);
        backgrounds.add(measured.background);
      }
      await proofShot(chrome, 'link-invitation', width);
    }
    assert.equal(backgrounds.size, 2, 'the card uses the light and dark surface tokens');
    available = false;
    await chrome.send('Page.reload');
    await chrome.waitFor("data?.project?.root && !document.body.classList.contains('loading')");
    await chrome.stable('sharingReady');
    await openItems(chrome); // the first-run Dashboard hides the card, so a person opens Items first.
    assert.equal(await chrome.stable("document.querySelector('#share-note').hidden"), true);
    assert.equal(await chrome.stable("document.querySelector('#share-again').hidden"), true, 'no entry when sharing is unavailable');
    assert.deepEqual(failures, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    if (view) await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
