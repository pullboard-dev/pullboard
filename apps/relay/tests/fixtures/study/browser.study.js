/** @pullboard-test-gui */
/** What a paired browser does when its relay is down, slow, failing or refusing its engine [H5,H17]. Run it explicitly: the default gate skips *.study.js. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { relayClientFixture } from '../../../../cli/tests/fixtures/relay/client.js';
import {
  findChromeExecutable,
  startChrome,
} from '../../../../cli/tests/fixtures/relay/browser.js';
import { faultProxy } from '../../../../../packages/pages/tests/fixtures/study.js';

// Budget: declared observation window; the bar names a 5 s slow relay, so each fault is watched for four of those.
const OBSERVE_MS = 20_000;
// Budget: declared recovery ceiling after the fault clears, measured, never asserted.
const RECOVER_MS = 30_000;

/** Read what the page shows now: the relay notice, the live line, and whether each title is on the board. */
async function pageState(chrome, titles) {
  return JSON.parse(await chrome.evaluate(`JSON.stringify({
    notice: (document.querySelector('#relay-notice')?.textContent ?? '').trim().slice(0, 200),
    live: (document.querySelector('#live')?.textContent ?? '').trim().slice(0, 200),
    shown: ${JSON.stringify(titles)}.map(title => (document.querySelector('#chain')?.textContent ?? '').includes(title)),
  })`));
}

/** Poll the page until a condition holds or the window ends, keeping every distinct state it passed through. */
async function watch(chrome, titles, windowMs, done) {
  const started = performance.now(), seen = [];
  let state;
  do {
    state = await pageState(chrome, titles);
    const key = JSON.stringify(state);
    if (seen.at(-1)?.key !== key) seen.push({ key, atMs: Math.round(performance.now() - started), ...state });
    if (done(state)) return { reachedMs: Math.round(performance.now() - started), seen };
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (performance.now() - started < windowMs);
  return { reachedMs: null, seen };
}

test('relay study measures a paired browser across relay faults [H5,H17]', {
  timeout: 600_000, skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const first = 'Browser study seed';
  assert.equal((await box.cli('add', box.lane, first)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = readFileSync(box.keyFile, 'utf8').trim();
  const proxy = await faultProxy(t, box, { rewriteLink: false });
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const cookie = await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token,
    url: proxy.origin, httpOnly: true, sameSite: 'Lax' });
  assert.equal(cookie.success, true);
  await chrome.navigate(proxy.origin + '/#board=' + link.board + '&key=' + key);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(first) + ')');
  for (const fault of ['down', 'slow-5s', '5xx', 'stale-engine']) {
    proxy.set(fault === 'down' ? { down: true } : { delayMs: fault === 'slow-5s' ? 5000 : 0,
      status: fault === '5xx' ? 503 : fault === 'stale-engine' ? 409 : null,
      code: fault === 'stale-engine' ? 'ENGINE_VERSION' : 'RELAY_UNAVAILABLE' });
    proxy.drop();
    const title = 'Browser study move during ' + fault;
    assert.equal((await box.cli('add', box.lane, title)).code, 0, 'the native board keeps moving on its direct link');
    const during = await watch(chrome, [first, title], OBSERVE_MS, state => state.shown[1]);
    proxy.set();
    proxy.drop();
    const after = during.reachedMs === null ? await watch(chrome, [first, title], RECOVER_MS, state => state.shown[1]) : null;
    t.diagnostic(JSON.stringify({ phase: 'browser-transport-failure', fault, node: process.versions.node,
      newMoveShownDuringFaultMs: during.reachedMs, statesDuringFault: during.seen.map(({ key, ...state }) => state),
      recoveredAfterClearMs: after?.reachedMs ?? null, statesAfterClear: after?.seen.map(({ key, ...state }) => state) ?? [],
      scope: 'Real Chrome paired through a loopback fault proxy in front of the private relay; the CLI publishes directly.' }));
  }
});
