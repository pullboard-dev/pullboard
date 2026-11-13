// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit search timeout and focus [N26] */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  searchFor,
} from '../../../tests/fixtures/cockpit/harness.js';

/** Capture the current search page and its last real board-state request without exposing the session key. */
async function searchSetupState(chrome) {
  const caughtAt = new Date().toISOString();
  const requests = chrome.requests.filter(({ method, url }) => {
    let path;
    try { path = new URL(url).pathname; } catch { return false; }
    return method === 'GET' && /^\/api\/v1\/boards\/[^/]+\/state$/.test(path);
  });
  const last = requests.at(-1);
  let page = null, captureError = null;
  try {
    page = JSON.parse(await chrome.stable(`JSON.stringify({
      project: typeof data === 'object' && data?.project ? { root: data.project.root, name: data.project.name ?? null } : null,
      itemCount: typeof data === 'object' && Array.isArray(data?.project?.items) ? data.project.items.length : null
    })`));
  } catch (error) {
    captureError = `${error.name}: ${error.message}`;
  }
  return {
    caughtAt,
    pageObservedAt: new Date().toISOString(),
    project: page?.project ?? null,
    itemCount: page?.itemCount ?? null,
    lastStateRequest: last ? { method: last.method, path: new URL(last.url).pathname } : null,
    captureError,
    rootCauseStatus: 'NOT PROVEN',
  };
}

test('the search step names its state on timeout [N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search checks.');
  const box = machine();
  const alpha = project(box, 'stalled-search');
  fixtureAdd(box.run, alpha.repo, 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  const view = await startView(box);
  const profile = privateFixtureFiles('pullboard-stalled-search-chrome-').root;
  let chrome;
  /** The record a timed-out search step carries, read from its message. */
  const record = (error) => JSON.parse(error.message.slice(error.message.indexOf('{')));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    try {
      await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 1");
    } catch (error) {
      // Snapshot the request list before the asynchronous page observation; never replace the wait failure.
      let capture;
      try {
        capture = await searchSetupState(chrome);
      } catch (captureError) {
        capture = {
          caughtAt: new Date().toISOString(), pageObservedAt: null,
          project: null, itemCount: null, lastStateRequest: null,
          captureError: `${captureError.name}: ${captureError.message}`,
          rootCauseStatus: 'NOT PROVEN',
        };
      }
      error.diagnostic = capture;
      error.message += `; search setup state observed after timeout ${JSON.stringify(capture)}`;
      throw error;
    }
    // A field that takes no typing: the step times out, and its message says how far the search got.
    await chrome.stable("document.querySelector('#q').disabled = true");
    let stalled;
    await assert.rejects(searchFor(chrome, 'greeting', 1_500), (error) => { stalled = error; return true; });
    assert.match(stalled.message, /^the search for "greeting" did not show its results: \{/, 'the step says which search stalled');
    assert.deepEqual(Object.keys(record(stalled)), ['value', 'focused', 'windowFocus', 'resultsHidden', 'closedBy'], 'it records the value, the focus, the window focus, and the results with what closed them');
    assert.deepEqual([record(stalled).value, record(stalled).focused, typeof record(stalled).windowFocus, record(stalled).resultsHidden], ['', 'body', 'boolean', true], `no words reached the field, which never had focus: ${stalled.message}`);
    // Results that showed and were then closed say what closed them: here, leaving the field.
    await chrome.stable("document.querySelector('#q').disabled = false");
    await searchFor(chrome, 'greeting');
    await chrome.stable("document.querySelector('#q').blur()");
    await chrome.waitFor("document.querySelector('#find-results').hidden");
    assert.equal(await chrome.stable("document.querySelector('#find-results').dataset.why"), 'left the field', 'leaving the field closes the results and says so');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});


test('search keeps focus through Esc [N26,C7]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search-focus checks.');
  const box = machine(), demo = project(box, 'search-focus');
  fixtureAdd(box.run, demo.repo, 'web', 'Greeting focus proof', '--specs', 'G1', '--criterion', 'visible');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'search-focus-chrome'));
    await chrome.waitFor('data?.project?.items?.length === 1');
    await chrome.stable(`(() => {
      window.__searchFocus = [];
      document.querySelector('#q').addEventListener('keydown', event => {
        if (event.key === 'Escape') window.__searchFocus.push({ focused: document.activeElement.id, window: document.hasFocus(), key: event.key });
      }, { capture: true });
    })()`);
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await searchFor(chrome, 'Greeting');
      assert.equal(await chrome.stable('document.activeElement.id'), 'q', `${width}: typing and settling results retain the search field's focus`);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      // budget: 120ms is the page's declared blur-close delay; observe after that callback can run.
      await chrome.stable('new Promise(resolve => setTimeout(resolve, 120))');
      const result = await chrome.stable(`({ focus: window.__searchFocus.at(-1), value: document.querySelector('#q').value, hidden: document.querySelector('#find-results').hidden, why: document.querySelector('#find-results').dataset.why })`);
      assert.equal(result.focus?.focused, 'q', `${width}: Escape is actually delivered while the search field is focused`);
      assert.equal(result.focus?.key, 'Escape');
      assert.deepEqual([result.value, result.hidden, result.why], ['', true, 'escape'], `${width}: Escape's own blur does not replace its close reason`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
