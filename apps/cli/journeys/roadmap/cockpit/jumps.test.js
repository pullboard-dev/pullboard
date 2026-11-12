// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: release jumps from the panel, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  tapTarget,
  machine,
  project,
  build,
  startView,
  target,
  accept,
  chromeExecutable,
  closeSnapshotChrome,
  press,
  proofShot,
  earlier,
} from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

test('the roadmap panel jumps to each release [N26]', {
  timeout: 150_000, //budget: hang ceiling for real Chrome startup, fourteen jumps at two widths, and panel scrolling.
}, async (t) => {
  const began = performance.now();
  /** Name each stage boundary and its elapsed time, so a slow run reads as a diagnosis. */
  const stage = phase => console.log('roadmap-jumps-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for Roadmap panel navigation.');
  stage('setup-start');
  const box = machine();
  const alpha = project(box, 'roadmap-panel-jumps');
  for (const title of ['Shipped release item', 'Next release item']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  stage('items-added');
  build(box, alpha, 1, 'shipped.html');
  accept(box, alpha, 1);
  const shippedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:1`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', shippedBranch);
  box.run(alpha.repo, 'merged', '1', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  // The board's own writer, as shout/journey.test.js uses it: a release add is one call here, not one CLI process each.
  const arrange = (add) => earlier(alpha.repo, Date.now(), (board) => add((name, note, items) => store.addMilestone(board, { agentId: 'coordinator', name, note, items, ...(items.length ? { reason: 'Arrange fixture release' } : {}) })));
  arrange((add) => {
    add('0.8.6', 'Shipped first line.\nThis line stays in the expanded history.', [1]);
    add('0.8.7', 'The next release.', [2]);
  });
  box.run(alpha.repo, 'milestone', 'ship', '0.8.6', '--next', '0.8.7');
  stage('shipped-release');
  arrange((add) => {
    for (const name of ['0.8.8', '0.8.9', '0.8.10', '0.8.11', '0.8.12', '0.8.13', '0.8.14', '0.8.15', '0.8.16', '0.8.17', '0.8.18', '0.8.19']) add(name, 'Queued after the next release.', []);
  });
  stage('setup-end');
  const view = await startView(box);
  stage('view-ready');
  const profiles = ['a', 'b', 'c'].map((name) => mkdtempSync(join(tmpdir(), `pullboard-roadmap-panel-jumps-${name}-`)));
  const chromes = [];
  /** Read panel selection, list targets, and page overflow after the shared Chrome wait, with each arrival mark set so far. */
  const reader = (chrome) => async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
    const buttons = [...panel.querySelectorAll('[data-roadmap-jump]')];
    const targets = [...list.querySelectorAll(':scope > [data-key]')];
    const rect = element => { const r = element.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height}; };
    const bar = document.querySelector('.top').getBoundingClientRect();
    return {buttons:buttons.map(b=>({key:b.dataset.roadmapJump,name:b.querySelector('span').textContent,count:b.querySelector('b').textContent,current:b.getAttribute('aria-current'),height:rect(b).height})),
      targets:targets.map(e=>({key:e.dataset.key,rect:rect(e),arrival:e.classList.contains('roadmap-arrival'),expanded:e.querySelector(':scope > .milestone-head')?.getAttribute('aria-expanded')})),
      panel:rect(panel),bar:{top:bar.top,bottom:bar.bottom},strip:rect(panel.querySelector('.roadmap-releases')),
      stripWidth:panel.querySelector('.roadmap-releases').scrollWidth,stripClient:panel.querySelector('.roadmap-releases').clientWidth,
      viewport:document.documentElement.clientWidth,scrollY:window.scrollY,pageWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),arrivals:window.__arrivals||[]};
  })())`));
  try {
    // Three Chromes read the one view: one checks the panel's edge, one the phone width and one the wide width, so the
    // edge and the two widths' fourteen jumps run side by side instead of one after the other.
    const [edgeChrome, phone, wide] = await Promise.all(profiles.map(async (profile) => { const opened = await openRoadmapChrome(executable, view.link.href, profile); chromes.push(opened); return opened; }));
    stage('chrome-ready');
    await Promise.all([edgeChrome, phone, wide].map((each) => each.waitFor('data?.project?.milestones?.length === 14')));
    stage('state-ready');
    // The panel's breakpoint is below 900px, not at it: at 900 the panel stays on the right, sticky, with its own
    // Shipping; at 899 it is the chip row above the list, and the counts sit under the next release.
    /** Check the panel's edge: where it sits beside the list and where it becomes the chip row. */
    async function edges(chrome) {
      for (const scheme of ['light', 'dark']) {
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
        for (const width of [900, 899]) {
          await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
          await chrome.waitFor(`innerWidth === ${width}`);
          await press(chrome, "document.querySelector('[data-tab=roadmap]')");
          const edge = JSON.parse(await chrome.stable(`JSON.stringify((() => {
            const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
            const shown = (e) => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0;
            return { position: getComputedStyle(panel).position, beside: panel.getBoundingClientRect().left >= list.getBoundingClientRect().right,
              chips: getComputedStyle(document.querySelector('#roadmap-releases')).display, desk: shown(panel.querySelector('.roadmap-desktop-shipping')), phone: shown(list.querySelector('.roadmap-summary')),
              page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) };
          })())`));
          const at = `${width}/${scheme}`;
          stage('edge-' + at);
          if (width === 900) assert.deepEqual([edge.position, edge.beside, edge.desk, edge.phone], ['sticky', true, true, true], `${at}: the panel stays on the right alongside each release summary: ${JSON.stringify(edge)}`);
          else assert.deepEqual([edge.position, edge.beside, edge.chips, edge.desk, edge.phone], ['static', false, 'flex', false, true], `${at}: the chip row above the list, summary under each release: ${JSON.stringify(edge)}`);
          assert.ok(edge.page <= width, `${at}: no sideways scroll: ${JSON.stringify(edge)}`);
        }
      }
    }

    /** Drive one width's panel checks and its fourteen jumps in one Chrome. */
    async function pass(chrome, width) {
      const read = reader(chrome);
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      stage('width-' + width);
      const initial = await read();
      if (width >= 900) {
        assert.ok(initial.buttons.every((button) => button.height >= tapTarget(width)), 'wide fine-pointer release jumps meet the 32px target');
        // Touch is turned off again below, and the wait is for the pointer the page started with, as demo.test.js
        // does: a Chrome with no mouse, as on Linux CI, starts at none, not fine (#453).
        const originalPointer = JSON.parse(await chrome.stable(`JSON.stringify({ fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches, none:matchMedia('(pointer: none)').matches })`));
        await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
        const coarse = await read();
        assert.ok(coarse.buttons.every((button) => button.height >= 44), 'wide coarse-pointer release jumps meet the 44px target');
        await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await chrome.waitFor(`matchMedia('(pointer: fine)').matches === ${originalPointer.fine} && matchMedia('(pointer: coarse)').matches === ${originalPointer.coarse} && matchMedia('(pointer: none)').matches === ${originalPointer.none}`);
      }
      const keys = ['m:0.8.7', 'm:0.8.8', 'm:0.8.9', 'm:0.8.10', 'm:0.8.11', 'm:0.8.12', 'm:0.8.13', 'm:0.8.14', 'm:0.8.15', 'm:0.8.16', 'm:0.8.17', 'm:0.8.18', 'm:0.8.19', 'shipped'];
      assert.deepEqual(initial.buttons.map((button) => button.key), keys, `${width}: each upcoming release in order and one Shipped jump`);
      assert.deepEqual(initial.buttons.map(({ name, count }) => [name, count]), [['0.8.7', '0/1'], ...keys.slice(1, -1).map((key) => [key.slice(2), '0/0']), ['Shipped', '1']], `${width}: release names and done counts are visible`);
      assert.ok(initial.buttons.every((button) => button.height >= tapTarget(width)), `${width}: every release jump meets the target size`);
      assert.ok(initial.pageWidth <= initial.viewport, `${width}: the page never scrolls sideways`);
      if (width < 900) {
        assert.ok(initial.stripWidth > initial.stripClient, 'phone release chips scroll inside their own row');
        assert.ok(initial.panel.bottom <= initial.targets[0].rect.top, 'the phone panel sits above the release list');
        // A board refresh redraws the Roadmap; the chips stay where the person scrolled them.
        const kept = JSON.parse(await chrome.stable("(() => { const row = document.querySelector('#roadmap-releases'); row.scrollLeft = row.scrollWidth; const before = row.scrollLeft; render(); return JSON.stringify([before, document.querySelector('#roadmap-releases').scrollLeft]); })()"));
        assert.ok(kept[0] > 0 && kept[1] === kept[0], `375: a redraw keeps the chips where they were scrolled: ${JSON.stringify(kept)}`);
        await chrome.stable("(() => { document.querySelector('#roadmap-releases').scrollLeft = 0; return true; })()");
      }
      await proofShot(chrome, 'roadmap-panel-jumps', width);
      // The page marks a release it jumps to for a moment, then clears the mark. Record each mark as it is set,
      // so a busy machine that reads late still sees it (a fixed window is the #400 class of red). The list is redrawn
      // when the board refreshes, so the watch is on the document.
      await chrome.stable("(() => { window.__arrivals = []; if (!window.__arrivalWatch) { window.__arrivalWatch = new MutationObserver((changes) => { for (const change of changes) if (change.target.classList?.contains('roadmap-arrival') && change.target.closest('#roadmap-list')) window.__arrivals.push(change.target.dataset.key); }); window.__arrivalWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); } return true; })()");
      stage('jumps-' + width);
      for (const key of keys.slice(0, -1)) {
        await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]')`);
        const moved = await read();
        const target = moved.targets.find((entry) => entry.key === key);
        const marked = moved.arrivals.includes(key);
        assert.ok(marked && target.rect.bottom > moved.bar.bottom && target.rect.top < 900, `${width}: selecting ${key} scrolls it into view and marks it: ${JSON.stringify({ ...target, marked })}`);
        const atTop = moved.targets.find((entry) => entry.rect.bottom > moved.bar.bottom + 8)?.key || moved.targets.at(-1).key;
        assert.equal(moved.buttons.find((button) => button.key === atTop).current, 'location', `${width}: the panel marks the release actually at the top of the list`);
      }
      stage('shipped-' + width);
      await press(chrome, "document.querySelector('#roadmap-panel [data-roadmap-jump=shipped]')");
      assert.equal((await read()).targets.at(-1).expanded, 'true', `${width}: selecting Shipped opens it`);
      const beforeListScroll = await read();
      await chrome.stable("document.querySelector('#roadmap-list [data-key=\"m:0.8.12\"]').scrollIntoView({block:'start',behavior:'instant'})");
      const scrolled = await read();
      const atTop = scrolled.targets.find((entry) => entry.rect.bottom > scrolled.bar.bottom + 8)?.key || scrolled.targets.at(-1).key;
      assert.notEqual(scrolled.scrollY, beforeListScroll.scrollY, `${width}: scrolling to a middle release moves the list`);
      assert.notEqual(scrolled.buttons.find((button) => button.current === 'location')?.key, beforeListScroll.buttons.find((button) => button.current === 'location')?.key, `${width}: scrolling changes the active release`);
      assert.equal(scrolled.buttons.find((button) => button.key === atTop).current, 'location', `${width}: scrolling the list updates the marker for the release actually at the top`);
      assert.ok(scrolled.pageWidth <= scrolled.viewport, `${width}: navigation keeps the page within its width`);
      if (width >= 900) assert.ok(scrolled.panel.top >= scrolled.bar.bottom + 8 && scrolled.panel.top <= scrolled.bar.bottom + 24, `desktop panel stays beside the list while scrolling: ${JSON.stringify(scrolled.panel)}`);
    }
    await Promise.all([edges(edgeChrome), pass(phone, 375), pass(wide, 1280)]);
  } finally {
    for (const each of chromes) await closeSnapshotChrome(each);
    for (const profile of profiles) rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
