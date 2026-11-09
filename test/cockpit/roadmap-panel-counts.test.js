// pullboard: browser
/** @pullboard-test-gui */
/** Roadmap release panel count and shipment journey [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from './fixture.js';
import { project } from './fixture.js';
import { build } from './fixture.js';
import { accept } from './fixture.js';
import { startView } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { press } from './fixture.js';
import { proofShot } from './fixture.js';

test('the roadmap panel counts the next release by stage [N26]', {
  timeout: 180_000, //budget: hang ceiling for six real item lifecycles and merged receipts before four viewport/theme checks.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for Roadmap shipping counts.');
  const box = machine();
  const alpha = project(box, 'roadmap-panel-counts');
  for (const title of ['Open', 'Building', 'In review', 'Accepted', 'Verified', 'Shipped']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 3, 'submitted.html');
  build(box, alpha, 4, 'accepted.html');
  accept(box, alpha, 4);
  build(box, alpha, 5, 'verified.html');
  accept(box, alpha, 5);
  const mergedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:5`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', mergedBranch);
  box.run(alpha.repo, 'merged', '5', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  build(box, alpha, 6, 'last-shipped.html');
  accept(box, alpha, 6);
  const shippedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:6`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', shippedBranch);
  box.run(alpha.repo, 'merged', '6', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  box.run(alpha.web, 'claim', '2');
  box.run(alpha.repo, 'milestone', 'add', '0.8.6', '--note', 'The last shipped note.\nA second detail line.', '--items', '6', '--reason', 'the test release names its shipped item');
  box.run(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'Shipping next.', '--items', '1,2,3,4,5', '--reason', 'the test release takes the next items');
  box.run(alpha.repo, 'milestone', 'ship', '0.8.6', '--next', '0.8.7');
  const shippedAt = JSON.parse(box.run(alpha.repo, 'roadmap', '--json')).milestones.find(milestone => milestone.name === '0.8.6').shipped.at;
  const shippedLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(shippedAt)) + ' · on npm';
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-panel-counts-'));
  let chrome;
  /** Read the visible stage counts and the bounded last-shipped summary. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const card=document.querySelector('#roadmap-panel'), rect=e=>{const r=e?.getBoundingClientRect();return r ? {top:r.top,bottom:r.bottom,height:r.height} : {top:0,bottom:0,height:0};};
    const last=[...document.querySelectorAll('#roadmap .roadmap-last-shipped')].find(e=>e.getBoundingClientRect().height>0);
    return {next:document.querySelector('#roadmap-list > .milestone > .release-header .release-name').textContent,
      counts:[...document.querySelectorAll('#roadmap .roadmap-desktop-shipping [data-shipping-stage]')].filter(e=>e.getBoundingClientRect().height>0).map(e=>[e.dataset.shippingStage,e.querySelector('dd').textContent]),
      shipped:last ? [...last.children].map(e=>e.textContent) : null,
      panel:rect(card),desktop:rect(card.querySelector('.roadmap-desktop-shipping')),mobile:rect(document.querySelector('.roadmap-list .roadmap-mobile-shipping')),
      heading:rect(document.querySelector('#roadmap-list > .milestone > .release-header .release-name')),
      mobileCounts:rect(document.querySelector('#roadmap-list > .milestone .roadmap-mobile-shipping .roadmap-stage-counts')),
      headerCounts:[...document.querySelector('#roadmap-list > .milestone').querySelectorAll('[data-summary-state]')].map(e=>[e.dataset.summaryState,e.querySelector('b').textContent]),
      documentWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),viewport:document.documentElement.clientWidth,viewportHeight:document.documentElement.clientHeight};
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 2');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      for (const scheme of ['light', 'dark']) {
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const counts = await read();
        assert.equal(counts.next, '0.8.7', `${width}/${scheme}: the panel names the next release`);
        const expected = [['landed', '1'], ['landing', '1'], ['review', '1'], ['building', '1'], ['waiting', '1'], ['held', '0']];
        assert.deepEqual(counts.headerCounts, expected, `${width}/${scheme}: the header reads every supplied state`);
        assert.deepEqual(counts.counts, width < 900 ? [] : expected, `${width}/${scheme}: the desktop companion panel shares those supplied counts`);
        assert.deepEqual(counts.shipped, ['Last shipped', '0.8.6', shippedLabel], `${width}/${scheme}: the last shipped row names its recorded publish date without exposing the note`);
        assert.ok(counts.documentWidth <= counts.viewport, `${width}/${scheme}: the page never scrolls sideways`);
        if (width < 900) assert.ok(counts.heading.top < counts.mobileCounts.top && counts.mobile.height > 0 && counts.desktop.height === 0, `${width}/${scheme}: counts sit under the actual next release heading on the phone`);
        else assert.ok(counts.desktop.height > 0 && counts.mobile.height === 0, `${width}/${scheme}: desktop shipping counts stay in the right panel alongside the header`);
      }
      await proofShot(chrome, 'roadmap-panel-counts', width);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
