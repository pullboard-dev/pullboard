// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap rows open their items across boards, update live and keep their address [N26,N38]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  project,
  fetchLive,
  fetchPage,
  startView,
  accept,
  chromeExecutable,
  closeSnapshotChrome,
  press,
  travel,
  settled,
  roadmapRow,
  showing,
  readRoadmap,
  openRoadmapParts,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  openRoadmapChrome,
  openRoadmapItem,
  landRoadmapItem,
} from '../../../tests/fixtures/cockpit/roadmap.js';

import { roadmapStagesBoard } from '../../../tests/fixtures/cockpit/roadmap-stages.js';

test('Roadmap rows open their items across boards and update live [N26,N38]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for roadmap browser checks.');
  const phaseStarted = Date.now();
  /** Preserve which real fixture phase ran before a timeout, without changing its budget. */
  const phase = name => t.diagnostic('roadmap phase ' + name + ' ' + (Date.now() - phaseStarted) + 'ms');
  phase('start');
  const { box, alpha, beacon } = roadmapStagesBoard(phase);
  phase('states-ready');
  const view = await startView(box);
  phase('view-ready');
  const roadmapPath = '/roadmap-demo/roadmap';
  const roadmap = `${roadmapPath}${view.link.search}`;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-chrome-'));
  let chrome;
  try {
    const direct = await fetchPage(view, roadmapPath);
    assert.equal(direct.status, 200, 'the view serves its page at /roadmap, behind its session cookie');
    assert.equal((await fetchLive(new URL('/roadmap', view.link))).status, 403, 'and nothing there without the secret');
    chrome = await openRoadmapChrome(executable, new URL(roadmap, view.link).href, profile);
    const consoleErrors = [];
    chrome.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    });
    await chrome.send('Log.enable');
    await settled(chrome, `!!data?.project && ${showing('roadmap', roadmapPath)} && document.querySelectorAll('#roadmap .milestone').length === 3`);
    phase('browser-ready');
    // This story reads every release; open the later cards through their actual controls.
    await openRoadmapParts(chrome);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor(`innerWidth === 1280 && ${showing('roadmap', roadmapPath)}`);
    const seen = await readRoadmap(chrome);

    // Another repo's item opens on its own board, and Back and Forward move between the two boards.
    // Since b94d43bd4a the Items list draws its state dot as a soft tint behind an icon, so the dot is matched by its state class.
    const beaconDot = await chrome.stable(`${roadmapRow('beacon#1')}.querySelector('.dot').className`);
    await openRoadmapItem(chrome, 'beacon#1');
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'beacon' && ${showing('items', '/beacon/items/1')} && document.querySelector('#detail h2')?.innerText.includes('Billing webhook retries') && !!document.querySelector('#detail .item-panel-status .item-stage')`);
    const there = JSON.parse(await chrome.stable(`JSON.stringify((() => { const chip = document.querySelector('#detail .item-panel-status .item-stage'); return {
      id: document.querySelector('#detail h2 span').innerText, label: chip.querySelector('.stage-word').innerText, chip: getComputedStyle(chip.querySelector('.stage-word')).color + ' on ' + getComputedStyle(chip.querySelector('.stage-word')).backgroundColor,
      dot: document.querySelector('#chain [data-item="1"] .dot').className }; })())`));
    const crossed = seen.cards[0].rows.find((row) => row.id === 'beacon#1');
    assert.deepEqual(there, { id: '#1', label: crossed.label === 'Landed' ? 'Merged' : crossed.label, chip: crossed.chip, dot: beaconDot }, "the other repo's Items tab shows that item with the Roadmap's word and colours");
    await travel(chrome, -1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'roadmap-demo' && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('beacon#1')}`);
    await travel(chrome, 1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'beacon' && ${showing('items', '/beacon/items/1')} && document.querySelector('#detail h2')?.innerText.includes('Billing webhook retries')`);
    await travel(chrome, -1);
    await settled(chrome, `document.querySelector('#proj-name').textContent === 'roadmap-demo' && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('#1')}`);

    // Each of this board's rows opens its item on the Items tab, which gives it the same word and
    // colours, its list dot included; a withdrawn item is left out of the list while browsing.
    for (const row of seen.cards.flatMap((card) => card.rows).filter((each) => each.id.startsWith('#'))) {
      const roadmapDot = await chrome.stable(`${roadmapRow(row.id)}.querySelector('.dot').className`);
      await openRoadmapItem(chrome, row.id);
      await chrome.waitFor(`${showing('items', '/roadmap-demo/items/' + row.id.slice(1))} && document.querySelector('#detail h2 span')?.innerText === ${JSON.stringify(row.id)} && !!document.querySelector('#detail .item-panel-status .item-stage')`);
      const here = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const chip = document.querySelector('#detail .item-panel-status .item-stage'), word = chip.querySelector('.stage-word'), dot = document.querySelector('#chain [data-item="${row.id.slice(1)}"] .dot');
        return { label: word.innerText, chip: getComputedStyle(word).color + ' on ' + getComputedStyle(word).backgroundColor, dot: dot ? dot.className : 'not listed' };
      })())`));
      // The Roadmap words a landed item Landed (95cc1594e3, its mockup); the Items detail keeps the stage name Merged. Chip colours must still match.
      assert.deepEqual(here, { label: row.label === 'Landed' ? 'Merged' : row.label, chip: row.chip, dot: row.label === 'Withdrawn' ? 'not listed' : roadmapDot }, `${row.id}: the Items detail keeps the Roadmap stage and its state dot`);
      await travel(chrome, -1);
      await settled(chrome, `${showing('roadmap', roadmapPath)} && !!${roadmapRow(row.id)}`);
    }

    // It updates live as items move, here and on the other repo's board.
    accept(box, alpha, 4);
    await chrome.waitFor(`${roadmapRow('#4')}?.querySelector('.stage-word').innerText === 'Verified' && document.querySelector('#roadmap .roadmap-left [aria-label]').getAttribute('aria-label') === '1/5 landed'`, 15_000); // budget: hang ceiling for the accepted receipt and unchanged landed count to reach the browser; no throughput claim.
    landRoadmapItem(box, alpha, 4);
    await chrome.waitFor(`${roadmapRow('#4')}?.querySelector('.stage-word').innerText === 'Landed' && document.querySelector('#roadmap .roadmap-left [aria-label]').getAttribute('aria-label') === '2/5 landed'`, 15_000); // budget: hang ceiling for the real merge receipt and landed count to reach the browser; no throughput claim.
    box.run(beacon.web, 'claim', '1');
    await chrome.waitFor(`${roadmapRow('beacon#1')}?.querySelector('.stage-word').innerText === 'Building'`, 15_000); // budget: hang ceiling for the claimed external item to refresh; no throughput claim.

    // A board with no milestones says how one starts; the address stays the Roadmap's.
    await press(chrome, `document.querySelector('[data-root=${JSON.stringify(beacon.repo)}]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'beacon' && ${showing('roadmap', '/beacon/roadmap')} && document.querySelector('#roadmap').innerText.startsWith('No milestones yet.')`);
    await press(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'roadmap-demo' && !!${roadmapRow('#1')}`);

    // A reload keeps the explicit Roadmap address. A fresh board address opens Dashboard.
    await chrome.send('Page.reload');
    await settled(chrome, `!!data?.project && ${showing('roadmap', roadmapPath)} && !!${roadmapRow('#1')}`);
    await press(chrome, `document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor(showing('shouts', '/roadmap-demo/shouts'));
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await chrome.waitFor(showing('roadmap', roadmapPath));
    // A page keeps the tab it was last on (landingTab in session.js), so a fresh board starts with nothing remembered.
    await chrome.stable("(() => { Object.keys(localStorage).filter((key) => key.endsWith('pb.tab')).forEach((key) => localStorage.removeItem(key)); return true; })()");
    await chrome.send('Page.navigate', { url: view.link.href });
    await settled(chrome, `!!data?.project && ${showing('dashboard', '/roadmap-demo/dashboard')} && document.querySelector('.tab.on')?.dataset.tab === 'dashboard'`);
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    assert.deepEqual(consoleErrors, [], 'Chrome reports no console errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
