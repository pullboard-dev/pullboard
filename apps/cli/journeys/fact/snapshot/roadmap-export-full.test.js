// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit full-board export opened offline, split from roadmap.test.js so each file fits its own budget [N26]. */
import { main as nativeTestMain } from '../../../tests/fixtures/native.js';
import assert from 'node:assert/strict';
import { fetchLocal } from '../../../../../packages/sync/index.js';
import { exportView } from '../../../src/io/commands/view.js';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  build,
  sendBack,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  settled,
  serveFolder,
} from '../../../tests/fixtures/cockpit/harness.js';

test('the export asks for the full board [N26,A2]', { timeout: 90_000 }, // budget: hang-only ceiling for one export and one Chrome open of its item.
  async () => {
    const executable = chromeExecutable();
    assert.ok(executable, 'Chrome is required to open the exported item offline');
    const box = machine();
    const alpha = project(box, 'full-board');
    const criterion = 'The greeting renders from the snapshot alone.';
    await box.inProcess(alpha.repo, 'add', 'web', 'Offline greeting', '--specs', 'G1', '--criterion', criterion);
    build(box, alpha, 1, 'greeting.html');
    sendBack(box, alpha, 1, 'the first greeting needs a correction');
    await box.inProcess(alpha.web, 'fact', '1', 'measurement', 'The corrected greeting renders offline.');
    build(box, alpha, 1, 'greeting-fix.html');
    accept(box, alpha, 1);

    // The export reads the board through the local API with fetchLocal. Record each address it asks
    // for, never its key, and make every read through fetchLocal unchanged.
    const asked = [];
    /** Note the address of each API read, then read it through the export's own transport. */
    const fetchApi = (url, init) => {
      asked.push(new URL(String(url)));
      return fetchLocal(url, init);
    };
    const folder = join(box.dir, 'full-board-export');
    await exportView(alpha.repo, folder, { fetchApi, runCommand: nativeTestMain });
    // Since #6661 the export reads the state once as summaries, then each item's own detail, so no one read carries the whole board.
    const stateReads = asked.filter((url) => url.pathname.endsWith('/state'));
    assert.deepEqual(stateReads.map((url) => url.searchParams.get('detail')), ['summary'],
      `the export reads the state once, as summaries; it asked for ${asked.map((url) => url.pathname + url.search).join(', ')}`);
    assert.ok(asked.some((url) => url.pathname.endsWith('/items/1')), 'and reads item #1 in full, so the exported item keeps its whole detail');

    // With no API left to ask, the exported page still opens the item's criterion, verdicts and thread.
    const host = await serveFolder(folder, '/demo/');
    let chrome;
    try {
      chrome = await openSnapshotChrome(executable, `${host.base}/demo/#items/1`, join(box.dir, 'full-board-chrome'));
      await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length && view.item === 1 && !!document.querySelector('#detail .tl')");
      const opened = await chrome.stable(`(() => {
        const detail = document.querySelector('#detail');
        const part = (name) => [...detail.querySelectorAll('h3')].find((heading) => heading.textContent === name)?.parentElement;
        return {
          title: detail.querySelector('h2').innerText,
          criterion: part('Done when')?.querySelector('.item-panel-expand-text').innerText ?? null,
          verdicts: [...detail.querySelectorAll('#item-panel-panel-verdicts .verdict')].reverse().map((verdict) => [verdict.classList.contains('yes') ? 'ACCEPT' : 'REJECT', verdict.querySelector('.note').textContent]),
          moves: [...detail.querySelectorAll('.tl > li:not(.tl-fact)')].map((move) => move.dataset.timelineKind).reverse(), // a row folds its placement's event id, so it counts once
          facts: [...detail.querySelectorAll('.tl > .tl-fact .tl-body')].map((fact) => fact.textContent).filter((text) => !/^(?:Tier-1 shadow for gate receipt|Review comparison: )/u.test(text)),
        };
      })()`);
      assert.ok(opened.title.includes('Offline greeting'), `the address opens item #1: ${opened.title}`);
      assert.equal(opened.criterion, criterion, 'the exported item shows its criterion');
      assert.deepEqual(opened.verdicts, [['REJECT', 'the first greeting needs a correction'], ['ACCEPT', 'the page shows it']],
        'the exported item shows both verdicts with their notes');
      assert.deepEqual(opened.moves, ['add', 'claim', 'renew', 'proof-run', 'submit', 'reject', 'claim', 'renew', 'proof-run', 'submit', 'accept'], 'the exported thread shows every move including native proof receipts; rule-based placement stays out of the history (7772461bba)');
      assert.deepEqual(opened.facts, ['The corrected greeting renders offline.'], 'the exported thread shows its fact');
      assert.ok(host.requests.some((request) => request.path.endsWith('/state.json')), 'the page reads the exported state file');
      assert.deepEqual(host.requests.filter((request) => !request.path.startsWith('/demo/') || request.status !== 200), [],
        'every request stays in the exported folder and finds its file');
      assert.deepEqual(chrome.requests.map((request) => request.url).filter((url) => !url.startsWith(`${host.base}/demo/`) && !url.startsWith('data:')), [],
        'the page asks nothing outside the exported folder');
      assert.deepEqual(chrome.exceptions, [], 'the exported page opens the item without browser exceptions');
    } finally {
      if (chrome) await closeSnapshotChrome(chrome);
      await host.close();
    }
  });
