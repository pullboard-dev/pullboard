// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-test-input source-cell apps/view */
/** Each relay cause the phone can hit renders its own message in real Chrome at phone width [H5,N26,C7,#9459]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startChrome } from '../../../cli/tests/fixtures/chrome.js';
import { findChromeExecutable } from '../../../cli/tests/fixtures/chrome.js';
import { stableChrome } from '../../../cli/tests/fixtures/cockpit/stable.js';
import { cockpitPage } from '../../index.js';
import { composeViewStyles } from '../../index.js';
import { relayCauseMessage } from '../../src/logic/relay-cause.js';

/** The relay client's refusal as the phone's transport throws it: RELAY_UNAVAILABLE with the cause attached to it. */
const REFUSAL = 'The relay did not answer. Sign in again or retry.';
const CASES = {
  off: { cause: 'relay_off', machine: 'Tower' },
  excluded: { cause: 'excluded', machine: 'Tower', name: 'main-board', by: 'Pat', reason: 'private work' },
  down: { cause: 'connection', machine: 'Tower' },
};

/** A transport module whose client fails to start with a cause, the way the phone's client does once its status is set. */
function failingTransport(cause) {
  return `export function createTransport() { throw Object.assign(new Error(${JSON.stringify(REFUSAL)}), { code: 'RELAY_UNAVAILABLE', relayCause: ${JSON.stringify(cause)} }); }`;
}

/** The real hosted page, with the phone's marked root and status line, and one failing transport per case. */
async function startPhoneFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (type, body, status = 200) => response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    const name = url.pathname.slice(1);
    if (CASES[name]) {
      const page = cockpitPage('', { readOnly: true, requests: true, transportModule: `/transport-${name}.js`, apiHeaders: {}, stylesheet: '/view.css', relaySession: true, commandPhrases: () => ['add'] })
        .replace('<html', '<html data-relay-device="phone"')
        .replace(/<body[^>]*>/u, (open) => `${open}<section id="relay-screen"><p class="relay-live"><span></span></p></section>`);
      return send('text/html; charset=utf-8', page);
    }
    if (url.pathname.startsWith('/transport-')) return send('text/javascript', failingTransport(CASES[url.pathname.slice(11, -3)]));
    if (url.pathname === '/view.css') return send('text/css', composeViewStyles());
    return send('application/json', JSON.stringify({ error: 'not in this fixture' }), 404);
  });
  const origin = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('clause 1: relay off, board excluded and network down each render their own message at phone width in real Chrome [H5,N26,C7,#9459]', { timeout: 120_000 }, async (t) => {
  if (!findChromeExecutable()) return t.skip('Install Chrome or set PULLBOARD_CHROME for the relay cause check.');
  const fixture = await startPhoneFixture();
  const chrome = await stableChrome(await startChrome());
  try {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const shown = {};
    for (const name of Object.keys(CASES)) {
      await chrome.navigate(`${fixture.origin}/${name}`);
      await chrome.waitFor(`location.pathname === '/${name}' && innerWidth === 390 && (document.querySelector('#relay-screen .relay-live span')?.textContent ?? '') !== ''`);
      shown[name] = await chrome.stable("document.querySelector('#relay-screen .relay-live span').textContent");
    }
    const off = relayCauseMessage(CASES.off);
    const excluded = relayCauseMessage(CASES.excluded);
    assert.equal(shown.off, `${off.message} Run ${off.command}, then reload this page.`, 'relay off names the machine and the one fix command');
    assert.equal(shown.excluded, `${excluded.message} Run ${excluded.command}, then reload this page.`, 'an excluded board names who excluded it, why, and its relink command');
    assert.equal(shown.down, `${REFUSAL} Check your connection, then reload this page.`, 'a network failure stays a connection problem');
    assert.match(shown.off, /off on Tower|Tower/u);
    assert.match(shown.excluded, /excluded/u);
    assert.doesNotMatch(shown.off + shown.excluded, /Check your connection/u, 'a machine-side cause is never called a connection problem');
    assert.equal(new Set(Object.values(shown)).size, 3, 'the three states read three different ways');
  } finally {
    await chrome.close();
    await fixture.close();
  }
});
