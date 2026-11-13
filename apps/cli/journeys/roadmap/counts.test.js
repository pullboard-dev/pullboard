// pullboard: browser
/** @pullboard-test-gui */
/** Roadmap release panel count and shipment journey [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { build } from '../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { press } from '../../tests/fixtures/cockpit/harness.js';
import { proofShot } from '../../tests/fixtures/cockpit/harness.js';

test('the roadmap panel counts the next release by stage [N26]', {
  timeout: 180_000, //budget: hang ceiling for six real item lifecycles and merged receipts before four viewport/theme checks.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for Roadmap shipping counts.');
  const box = machine();
  const alpha = project(box, 'roadmap-panel-counts');
  for (const title of ['Open', 'Building', 'In review', 'Accepted', 'Verified', 'Shipped']) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 3, 'submitted.html');
  build(box, alpha, 4, 'accepted.html');
  accept(box, alpha, 4);
  build(box, alpha, 5, 'verified.html');
  accept(box, alpha, 5);
  const mergedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:5`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', mergedBranch);
  await box.inProcess(alpha.repo, 'merged', '5', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  build(box, alpha, 6, 'last-shipped.html');
  accept(box, alpha, 6);
  const shippedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:6`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', shippedBranch);
  await box.inProcess(alpha.repo, 'merged', '6', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  await box.inProcess(alpha.web, 'claim', '2');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.8.6', '--note', 'The last shipped note.\nA second detail line.', '--items', '6', '--reason', 'the test release names its shipped item');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'Shipping next.', '--items', '1,2,3,4,5', '--reason', 'the test release takes the next items');
  await box.inProcess(alpha.repo, 'milestone', 'ship', '0.8.6', '--next', '0.8.7');
  JSON.parse(await box.inProcess(alpha.repo, 'roadmap', '--json')).milestones.find(milestone => milestone.name === '0.8.6');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-panel-counts-'));
  let chrome;
  /** Read the visible stage counts and the bounded last-shipped summary. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const card=document.querySelector('#roadmap-panel'), rect=e=>{const r=e?.getBoundingClientRect();return r ? {top:r.top,bottom:r.bottom,height:r.height} : {top:0,bottom:0,height:0};};
    return {next:document.querySelector('#roadmap-list > .milestone > .release-header .release-name').textContent,
      railTiles:document.querySelectorAll('#roadmap-panel [data-shipping-stage], #roadmap-panel .roadmap-last-shipped, #roadmap-list .roadmap-mobile-shipping').length,
      railRows:[...document.querySelectorAll('#roadmap-panel .roadmap-release')].map(e=>e.textContent),
      landedText:document.querySelector('#roadmap-list > .milestone .release-header').textContent.match(/[0-9]+ of [0-9]+ landed/g)||[],
      heading:rect(document.querySelector('#roadmap-list > .milestone > .release-header .release-name')),
      card:rect(document.querySelector('#roadmap-list > .milestone > .milestone-body')),
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
        assert.deepEqual(counts.headerCounts, expected, `${width}/${scheme}: the header reads every supplied state, Landed in its chip row as on the Dashboard`);
        assert.equal(counts.landedText.length, 1, `${width}/${scheme}: the landed-of-total count appears once`);
        assert.equal(counts.railTiles, 0, `${width}/${scheme}: the rail holds no count tiles and no last-shipped block`);
        assert.ok(counts.railRows.every(text => !/\d+\/\d+/u.test(text)), `${width}/${scheme}: the Releases list repeats no landed count`);
        assert.ok(counts.heading.bottom <= counts.card.top, `${width}/${scheme}: the header sits above its card`);
        assert.ok(counts.documentWidth <= counts.viewport, `${width}/${scheme}: the page never scrolls sideways`);
      }
      await proofShot(chrome, 'roadmap-panel-counts', width);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
