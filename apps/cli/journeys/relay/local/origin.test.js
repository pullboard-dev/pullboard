// pullboard: browser
/** @pullboard-test-gui */
/** A hosted WebKit page opens an authenticated loopback board without a mixed-content fetch [H5,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import {
  machine,
  project,
  startView,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  findWebkitExecutable,
  startWebkit,
} from '../../../tests/fixtures/webkit.js';
import {
  BOARD_ITEM,
  BOARD_MS,
  visit,
} from '../../../tests/fixtures/hosted/shapes.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const HOSTED = 'https://app.pullboard.dev';

test('the hosted page finds this computer\'s view in WebKit without an http request from https [H5,N26]', async (t) => {
  if (!findWebkitExecutable()) return t.skip('No Playwright WebKit build; set PULLBOARD_WEBKIT to exercise the real browser route.');
  const box = machine();
  const board = project(box, 'webkit-local');
  const title = 'Private board reached through the local page';
  fixtureAdd(box.run, board.repo, 'web', title, '--specs', 'G1');
  fixtureAdd(box.run, board.repo, 'web', BOARD_ITEM, '--specs', 'G1');
  const view = await startView(box);
  let webkit, page;
  t.after(async () => {
    try { await page?.close(); }
    finally { try { await webkit?.close(); } finally { await view.stop(); } }
  });
  const browserHandler = createRelayBrowserHandler({ authenticate: async () => { throw new Refused('AUTH_REQUIRED', 'sign in'); } });
  const failures = [];
  webkit = await startWebkit();
  const options = {
    prepare: async (target) => {
      await target('Network.enable');
      await target('Page.enable');
      await target('Runtime.enable');
      await target('Page.setTouchEmulationEnabled', { enabled: false });
      await target('Page.setBootstrapScript', { source: `if (location.origin === ${JSON.stringify(HOSTED)}) {
        window.localFetches = []; const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => { const url = String(typeof input === 'string' ? input : input.url);
          if (url.startsWith('http:')) window.localFetches.push(url); return nativeFetch(input, init); };
      }` });
      await target('Network.setInterceptionEnabled', { enabled: true });
      // Only the hosted HTTPS assets are supplied. The real browser talks directly to the owned loopback view.
      await target('Network.addInterception', { url: '^https://app\\.pullboard\\.dev/', isRegex: true, stage: 'request' });
    },
    onMessage: (message, target) => {
      if (message.method !== 'Network.requestIntercepted') return;
      const { requestId, request } = message.params;
      void (async () => {
        assert.equal(new URL(request.url).origin, HOSTED, 'loopback traffic is never intercepted or Node-forwarded');
        let status = 404, headers = { 'content-type': 'text/plain' }, body = '';
        await browserHandler({ method: request.method, url: request.url, headers: request.headers }, {
          /** Retain the production asset's status and security headers. */
          writeHead(code, values) { status = code; headers = values; },
          /** Retain the asset bytes without forwarding a network request. */
          end(value) { body = value ?? ''; },
        });
        await target('Network.interceptRequestWithResponse', { requestId, status, statusText: 'OK', headers,
          mimeType: headers['content-type'].split(';')[0], base64Encoded: true, content: Buffer.from(body).toString('base64') });
      })().catch(error => { failures.push(error.message); void target('Network.interceptRequestWithError', { requestId, errorType: 'General' }).catch(() => {}); });
    },
  };
  page = await webkit.newPage(options);
  // A genuine top-level round trip learns this fixture's arbitrary port and tab secret, without injecting a key.
  await page.navigate(view.base + '/local/connect');
  try {
    await page.waitFor( // budget: hang ceiling for one hosted navigation to settle, not a speed assertion.
      `location.origin === ${JSON.stringify(HOSTED)} && document.readyState === 'complete'
      && document.querySelector('#local-note')?.dataset.state !== 'looking' && !document.body.classList.contains('loading')`, 5000);
  } catch (error) {
    console.log(JSON.stringify({ failures, exceptions: page.exceptions,
      runtime: await page.evaluate('({ ready:document.readyState, live:document.querySelector("#live")?.textContent, state:document.querySelector("#local-note")?.dataset.state, loading:document.body.className, browser:hostedBrowser(navigator), phone:document.documentElement.dataset.relayDevice })') }));
    throw error;
  }
  const seen = await page.evaluate(`({ state: document.querySelector('#local-note').dataset.state,
    words: document.querySelector('#local-note').textContent.trim(),
    open: !document.querySelector('#local-note-view').parentElement.hidden,
    href: document.querySelector('#local-note-view').href,
    fetches: window.localFetches, fragment: location.hash })`);
  assert.notEqual(await page.evaluate('document.documentElement.dataset.relayDevice'), 'phone', 'the regression exercises a desktop WebKit page');
  assert.equal(seen.open, true, `the hosted page gives a visible local-board action: ${seen.words}`);
  assert.equal(seen.href, view.base + '/local/view', 'the action keeps the actual known loopback port');
  assert.deepEqual(seen.fetches, [], 'the HTTPS document never tries an HTTP subresource request');
  assert.equal(seen.fragment, '', 'the round-trip secret was removed before displaying the action');
  assert.equal(await page.evaluate('!document.querySelector("#local-note-go").parentElement.hidden'), true, 'opening a local board does not remove relay sign-in');
  await page.evaluate('document.querySelector("#local-note-view").click()');
  await page.waitFor(`location.origin === ${JSON.stringify(view.base)} && document.body.innerText.includes(${JSON.stringify(title)})`);
  assert.equal((await fetch(view.base + '/')).status, 403, 'the same local view still refuses an unauthenticated visit');
  await page.close();
  page = await webkit.newPage(options);
  await page.navigate(HOSTED + '/');
  await page.waitFor('document.querySelector("#local-note")?.dataset.state === "local-open" && document.readyState === "complete"');
  const fresh = await page.evaluate('({ command:document.querySelector("#local-note-code").textContent, commandVisible:!document.querySelector("[data-part=command]").hidden, signIn:!document.querySelector("#local-note-go").parentElement.hidden, fetches:window.localFetches })');
  assert.equal(fresh.command, 'pullboard view', 'a first visit without a known port gives the command that opens the actual view');
  assert.equal(fresh.commandVisible, true);
  assert.equal(fresh.signIn, true, 'a first-visit Safari user can still sign in for shared boards');
  assert.deepEqual(fresh.fetches, [], 'first visits do not probe a guessed port');
  await page.close();
  const journey = await visit({ newPage: async () => {
    page = await webkit.newPage(options);
    return { ...page, poll: (expression, timeout) => page.waitFor(expression, timeout) };
  } }, { phone: false, localView: view.base + '/local/view' }, true);
  page = null; // visit owns and closes this page.
  assert.equal(journey.board, true, 'the hosted matrix follows the shown local-opening step and still requires the real private board');
  assert.ok(journey.ms <= BOARD_MS, `the matrix local-opening journey took ${journey.ms}ms`);
  assert.deepEqual(failures, [], 'the production hosted assets were served without forwarding local traffic');
});
