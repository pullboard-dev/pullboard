// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit activity checks, "loading" group, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import {
  createServer,
} from 'node:http';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  machine,
  project,
  fetchLive,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../../tests/fixtures/cockpit/harness.js';

test('older history says it is still loading until the stream completes [N26,H5]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for one real board, 43 CLI runs and one owned Chrome, not a throughput assertion.
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the history-loading proof.');
  const box = machine();
  const streaming = project(box, 'streaming');
  await box.inProcess(streaming.repo, 'add', 'web', 'Greet the visitor', '--criterion', 'greets');
  await box.inProcess(streaming.repo, 'shout', 'web', 'The oldest shout, read once the feed reaches its end');
  for (let n = 1; n <= 41; n++) await box.inProcess(streaming.repo, 'shout', 'web', `Filler ${n}`);
  const live = await startView(box);
  const reads = [];
  // The relay transport's shape (#903): board reads, plus historyProgress(boardId) the test moves by hand.
  const moduleSource = `/** Read the real private board, reporting history progress the test sets. */
export async function createTransport({ onUpdate }) {
  window.__history = { loaded: 120, total: 400, complete: false, sequence: 1 };
  window.__transportUpdate = onUpdate;
  return {
    historyProgress: () => ({ ...window.__history }),
    async request(path, body) {
      if (body != null) throw new Error('The stand-in permits board reads only.');
      const response = await fetch('/fixture' + path);
      const document = await response.json();
      if (!response.ok) throw new Error(document.error ? '[' + document.error.code + '] ' + document.error.message : 'read failed: ' + response.status);
      return document;
    },
  };
}`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
    if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(moduleSource);
    // The stylesheet and board reads come from the real view, so the case reads no source file itself.
    const forward = url.pathname === '/view.css' ? '/view.css' : url.pathname.slice('/fixture'.length) + url.search;
    if ((url.pathname !== '/view.css' && !url.pathname.startsWith('/fixture/')) || request.method !== 'GET') return response.writeHead(404).end();
    reads.push(url.pathname);
    fetchLive(live.base + forward, { headers: { 'x-pullboard-key': live.key } })
      .then(async (reply) => response.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/json' }).end(await reply.text()))
      .catch(() => response.writeHead(502).end());
  });
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-history-loading-'));
  let chrome;
  try {
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${server.address().port}/`, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await chrome.waitFor(`data?.project?.items.some((item) => item.title === 'Greet the visitor')`);
    const note = (kind) => `(document.querySelector('[data-history-note="${kind}"]')?.textContent ?? null)`;

    // The compact conversation list may already expose its end; prove the initial window before opening it.
    assert.equal(await chrome.stable(`data.project.shouts.some(shout => shout.shout_text.includes('The oldest shout'))`), false, 'the oldest shout is not among the forty on hand');
    assert.equal(reads.some((path) => /\/shouts\/\d+$/.test(path)), false, 'no older shout was requested before Shouts opens');
    // Streaming: the feed ends in the line, with how far along it is, and its end reads ten older shouts at a time.
    await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor(`${note('shouts')} === 'Older shouts are still loading (30%).'`);
    await chrome.click(`document.querySelector('[data-shout-thread="none"]')`);
    await chrome.waitFor('!!document.querySelector("#feed .shout")');
    assert.equal(await chrome.stable(`document.querySelector('#feed').lastElementChild.dataset.historyNote`), 'shouts', 'the line ends the feed');
    await chrome.stable(`document.querySelector('[data-history-note="shouts"]').scrollIntoView({ block: 'end' })`);
    await chrome.waitFor(`document.querySelector('#feed').textContent.includes('The oldest shout, read once the feed reaches its end')`);
    assert.ok(reads.some((path) => /\/shouts\/\d+$/.test(path)), 'the next page came from addressed shout reads');
    assert.equal(await chrome.stable(`document.querySelector('#feed').lastElementChild.dataset.historyNote`), 'shouts', 'the line still ends the longer feed');
    assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'no sideways scroll at 390px');

    // Activity: the same line; its end asks the transport for the board again, and the count moves in place.
    await chrome.click(`document.querySelector('[data-tab="activity"]')`);
    await chrome.waitFor(`${note('activity')} === 'Older activity is still loading (30%).'`);
    await chrome.stable(`(() => { const read = refresh; window.__pages = 0; refresh = (...args) => { if (new Error().stack.includes('historyNextPage')) window.__pages += 1; return read(...args); }; return true; })()`);
    await chrome.stable(`document.querySelector('[data-history-note="activity"]').scrollIntoView({ block: 'end' })`);
    await chrome.waitFor('window.__pages >= 1');
    await chrome.stable('window.__history.loaded = 300');
    await chrome.waitFor(`${note('activity')} === 'Older activity is still loading (75%).'`);

    // An item's thread ends its history with the line.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.click(`document.querySelector('[data-tab="items"]')`);
    await chrome.click(`document.querySelector('#chain [data-item]')`);
    await chrome.click(`document.querySelector('[data-item-panel-tab=history]')`);
    await chrome.waitFor(`${note('item')} === 'Older entries are still loading (75%).'`);

    // Complete: every line goes, and a redraw brings none back.
    await chrome.stable('window.__history = { loaded: 400, total: 400, complete: true, sequence: 1 }');
    await chrome.waitFor(`document.querySelectorAll('[data-history-note]').length === 0`);
    await chrome.stable('render()');
    for (const tab of ['shouts', 'activity', 'items']) {
      await chrome.click(`document.querySelector('[data-tab="${tab}"]')`);
      assert.equal(await chrome.stable(`document.querySelectorAll('[data-history-note]').length`), 0, `${tab} reads as complete`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await new Promise((closed) => server.close(closed));
    await live.stop();
  }
});
