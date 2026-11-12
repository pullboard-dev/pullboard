// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: stage words and addresses, using the shared real-board fixtures [N26]. */
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
  chromeExecutable,
  closeSnapshotChrome,
  press,
  travel,
  pressedInto,
  settled,
  showing,
  readRoadmap,
  openRoadmapParts,
  tabBar,
  proofShot,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  openRoadmapChrome,
  openRoadmapItem,
} from '../../../tests/fixtures/cockpit/roadmap.js';

import { roadmapStagesBoard } from '../../../tests/fixtures/cockpit/roadmap-stages.js';

test('the Roadmap uses its approved stage words and keeps its own address [N26,N38]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for roadmap browser checks.');
  const phaseStarted = Date.now();
  /** Preserve which real fixture phase ran before a timeout, without changing its budget. */
  const phase = name => t.diagnostic('roadmap phase ' + name + ' ' + (Date.now() - phaseStarted) + 'ms');
  phase('start');
  const { box, beacon, titles } = roadmapStagesBoard(phase);
  // What the person reads on each row: the approved stage word; rejected work is a separate mark. Rows follow the
  // backend's queue order, queued items first by position (36add4ed61, f8e8ce444a), never re-sorted by stage (b83469ff53).
  const words = [
    { id: '#3', label: 'Ready', tone: 'ready' },
    { id: '#4', label: 'In review', tone: 'in-review' },
    { id: '#2', label: 'Verified', tone: 'verified' },
    { id: 'beacon#1', label: 'Ready', tone: 'ready' },
    { id: '#1', label: 'Merged', tone: 'merged' },
    { id: '#5', label: 'Building', tone: 'building' },
    { id: '#6', label: 'Ready', tone: 'ready' },
  ];
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

    let seen;
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && ${showing('roadmap', roadmapPath)}`);
      seen = await readRoadmap(chrome);
      phase('rows-read-' + width);
      assert.deepEqual([seen.address, seen.shown, seen.tab], [roadmapPath, ['roadmap'], 'roadmap'], `${width}: the direct address shows the Roadmap tab, and only it`);
      assert.ok(seen.document <= seen.client && seen.body <= seen.client, `${width}: no sideways scroll: ${JSON.stringify(seen)}`);
      assert.deepEqual(seen.cards.map((card) => card.name), ['Launch', 'Next', 'Later'], `${width}: a card for each milestone, in order`);
      assert.deepEqual(seen.cards.map((card) => card.note), ['Ships when the review lands; your call on the name.', 'Queued behind Launch.', 'Ideas not filed yet.'], `${width}: each card's note`);
      assert.deepEqual(seen.cards.map((card) => [card.count, card.progress, card.filled]), [['1/5 landed', [1, 5], 0.2], ['0/2 landed', [0, 2], 0], [null, null, null]], `${width}: counts and bars say how many retained items landed`);
      assert.deepEqual([seen.cards[2].empty, seen.cards[2].rows.length], ['No items yet.', 0], `${width}: an empty milestone says so with zero summary counts`);
      const rows = seen.cards.flatMap((card) => card.rows);
      assert.deepEqual(rows.map(({ id, label, tone }) => ({ id, label, tone })), words, `${width}: each roadmap row uses an approved stage word`);
      assert.deepEqual(rows.filter((row) => row.id === '#3' || row.id === 'beacon#1').map((row) => row.marks), [['Sent back'], ['Sent back']], `${width}: a rejected item keeps its mark beside its stage`);
      assert.ok(rows.every((row) => row.seen), `${width}: every stage is on screen`);
      assert.deepEqual(rows.map((row) => row.title), [titles[2], titles[3], titles[1], 'Billing webhook retries', titles[0], titles[4], titles[5]], `${width}: queued items lead in queue order, then the rest, then landed items (36add4ed61)`);
      assert.deepEqual(rows.map((row) => row.tip), rows.map((row) => row.title), `${width}: each row's tooltip is its whole title`);
      assert.ok(rows.every((row) => row.lines === 1 && row.ellipsis), `${width}: every title holds one line, set to end in an ellipsis: ${JSON.stringify(rows)}`);
      assert.ok(rows.find((row) => row.id === '#6').cut, `${width}: the long title is cut, so its ellipsis shows`);
      assert.ok(rows.every((row) => row.button), `${width}: every item opens, another repo's included`);

      const bar = await tabBar(chrome);
      phase('tabs-read-' + width);
      for (const layout of bar.layouts) {
        const place = `${width} with ${layout.on} picked`;
        assert.equal(layout.tabs.length, 8, `${place}: Dashboard and seven retained tabs`);
        for (const tab of layout.tabs) assert.ok(tab.labelLeft >= tab.left + 2 && tab.labelRight <= tab.right - 2, `${place}: ${tab.tab}'s label sits inside its highlight: ${JSON.stringify(tab)}`);
        assert.equal(new Set(layout.tabs.map(tab => Math.round(tab.top))).size, width < 480 ? 2 : 1, `${place}: phone tabs use two rows, desktop one`);
        layout.tabs.forEach((tab, n) => { if (n) assert.ok(tab.top >= layout.tabs[n - 1].bottom - 0.5 || tab.left >= layout.tabs[n - 1].right - 0.5, `${place}: ${tab.tab} starts after the tab before it ends or on the next row`); });
        assert.ok(layout.tabs[0].left >= layout.bar[0] - 0.5 && layout.tabs.at(-1).right <= layout.bar[1] + 0.5 && layout.bar[1] <= bar.client, `${place}: the tab bar fits on screen: ${JSON.stringify(layout)}`);
      }
      await proofShot(chrome, 'roadmap', width);

      // An item opens on the Items tab; Back shows the Roadmap at its address again, Forward the item.
      await openRoadmapItem(chrome, '#3');
      await pressedInto(chrome, `${showing('items', '/roadmap-demo/items/3')} && document.querySelector('#detail h2')?.innerText.includes('Session timeout banner')`);
      assert.equal(await chrome.stable('location.search'), '', `${width}: the address keeps the rest of itself, which holds no key`);
      await travel(chrome, -1);
      await settled(chrome, `${showing('roadmap', roadmapPath)} && document.querySelector('.tab.on')?.dataset.tab === 'roadmap'`);
      await travel(chrome, 1);
      await settled(chrome, `${showing('items', '/roadmap-demo/items/3')} && document.querySelector('.tab.on')?.dataset.tab === 'items' && document.querySelector('#detail h2')?.innerText.includes('Session timeout banner')`);
      await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
      await pressedInto(chrome, `${showing('roadmap', roadmapPath)} && location.search === ''`);
    }

    await settled(chrome, `!!data?.project && ${showing('dashboard', '/roadmap-demo/dashboard')} && document.querySelector('.tab.on')?.dataset.tab === 'dashboard'`);
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    assert.deepEqual(consoleErrors, [], 'Chrome reports no console errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
