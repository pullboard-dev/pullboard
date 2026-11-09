// pullboard: browser
/** @pullboard-test-gui */
/** Prove the approved Roadmap release, row, wait and shipping presentation in real Chrome [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from './fixture.js';
import { project } from './fixture.js';
import { build } from './fixture.js';
import { sendBack } from './fixture.js';
import { accept } from './fixture.js';
import { startView } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { press } from './fixture.js';
import { pressedInto } from './fixture.js';

test('the Roadmap uses the approved shared release design at phone and desktop widths [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the approved Roadmap presentation.');
  const box = machine();
  const alpha = project(box, 'roadmap-redesign');
  box.run(alpha.repo, 'add', 'web', 'Dependency target', '--specs', 'G1', '--criterion', 'The page works.');
  box.run(alpha.repo, 'add', 'web', 'A dependent item with a long title that stays on one line beside its quiet prerequisite link', '--specs', 'G1', '--criterion', 'The page works.');
  box.run(alpha.repo, 'add', 'web', 'Active build', '--specs', 'G1', '--criterion', 'The page works.');
  box.run(alpha.repo, 'add', 'web', 'Submitted for review', '--specs', 'G1', '--criterion', 'The page works.');
  box.run(alpha.repo, 'add', 'web', 'Returned for changes', '--specs', 'G1', '--criterion', 'The page works.');
  box.run(alpha.repo, 'add', 'web', 'Previously shipped', '--specs', 'G1', '--criterion', 'The page works.');
  box.run(alpha.repo, 'edit', '2', '--after', '1');
  build(box, alpha, 4, 'review.txt');
  build(box, alpha, 5, 'return.txt');
  sendBack(box, alpha, 5, 'Revise the proof before resubmitting.');
  build(box, alpha, 6, 'shipped.txt');
  accept(box, alpha, 6);
  const shippedBranch = alpha.itemBranches.get(`${alpha.baseBranch}:6`);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', shippedBranch);
  box.run(alpha.repo, 'merged', '6', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  box.run(alpha.web, 'claim', '3');
  box.run(alpha.repo, 'milestone', 'add', '0.9.3', '--note', 'PRIVATE shipment note must never appear in Last shipped.\nSecond line.', '--items', '6', '--reason', 'Arrange the fixture releases');
  box.run(alpha.repo, 'milestone', 'add', '0.9.4: Restructure for Speed and Cost', '--note', 'Current release.', '--items', '1,2,3,4,5', '--reason', 'Arrange the fixture releases');
  box.run(alpha.repo, 'milestone', 'ship', '0.9.3', '--next', '0.9.4: Restructure for Speed and Cost');
  const roadmap = JSON.parse(box.run(alpha.repo, 'roadmap', '--json'));
  const shipped = roadmap.milestones.find(milestone => milestone.name === '0.9.3');
  const currentRelease = roadmap.milestones.find(milestone => milestone.name === '0.9.4: Restructure for Speed and Cost');
  const queuePositionById = new Map(currentRelease.items.map(item => [`#${item.id}`, String(item.position)]));
  const shippedDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(shipped.shipped.at)) + ' · on npm';
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-redesign-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.milestones?.some(milestone => milestone.name.startsWith('0.9.4'))");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    try {
      await pressedInto(chrome, "!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('#roadmap-list > .milestone')");
    } catch (error) {
      const state = await chrome.stable(`JSON.stringify({dataRoot:data?.root??null,viewRoot:view?.root??null,hasProject:!!data?.project,
        projectName:data?.project?.name??null,milestones:data?.project?.milestones?.map(milestone=>milestone.name)??null,
        paneHidden:document.querySelector('[data-pane=roadmap]')?.hidden??null,listHtmlLength:document.querySelector('#roadmap')?.innerHTML.length??null})`);
      throw new Error(`${error.message}; Roadmap render state ${state}; page exceptions ${JSON.stringify(chrome.exceptions)}`, { cause: error });
    }
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#roadmap-list > .milestone')`);
      const result = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const card=document.querySelector('#roadmap-list > .milestone'), rows=[...card.querySelectorAll(':scope > .milestone-body .milestone-item')];
        const releases=[...document.querySelectorAll('#roadmap-releases [data-roadmap-jump^="m:"]')];
        const last=[...document.querySelectorAll('.roadmap-last-shipped')].find(node=>node.getBoundingClientRect().height>0);
        const forecast=card.querySelector('.roadmap-forecast');
        const shippingCounts=[...document.querySelectorAll('.roadmap-stage-counts')].find(node=>node.getBoundingClientRect().height>0);
        const shippingCells=[...(shippingCounts?.children||[])].filter(node=>node.getBoundingClientRect().height>0);
        const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
        const rowFor=id=>rows.find(row=>row.dataset.roadmapKey==='i:#'+id);
        return {width:innerWidth,cardName:card.querySelector('.release-name')?.textContent||'',itemCount:card.querySelectorAll('.milestone-limit').length,
          pace:rect(forecast),paceLineHeight:parseFloat(getComputedStyle(forecast).lineHeight),paceFits:forecast.scrollWidth<=forecast.clientWidth,name:rect(card.querySelector('.release-name')),
          rows:rows.map(row=>({id:row.querySelector('.id')?.textContent||'',back:!!row.querySelector('.stage-mark.no, .roadmap-state.back'),label:row.querySelector('.stage-word')?.textContent||row.querySelector('.roadmap-stage-chip')?.textContent||'',
            order:row.querySelector('.queue-position')?.textContent||'',icon:!!row.querySelector('.roadmap-state svg'),after:row.querySelector('.roadmap-after')?.textContent.trim()||'',
            afterHref:row.querySelector('.roadmap-after a')?.getAttribute('href')||'',blockDots:row.querySelectorAll('.block-dot').length,titleLines:row.querySelector('.milestone-title')?.getClientRects().length||0,
            title:row.querySelector('.milestone-title')?.textContent||''})),
          releases:releases.map(button=>({name:button.querySelector(':scope > span')?.textContent||'',count:button.querySelector('b')?.textContent||'',
            progress:button.querySelector('svg')?{viewBox:button.querySelector('svg').getAttribute('viewBox'),rect:button.querySelector('rect')?.getAttribute('width')||''}:null})),
          shipping:shippingCells.map(node=>{const key=node.dataset.shippingStage;return {key,label:node.querySelector('dt')?.textContent.trim(),swatch:getComputedStyle(node.querySelector('i')).backgroundColor,
            headerSwatch:getComputedStyle(card.querySelector('.roadmap-summary-swatch.'+key)).backgroundColor};}),
          shippingColumns:new Set(shippingCells.map(node=>Math.round(rect(node).left))).size,
          last:last?[...last.children].map(node=>node.textContent):null,lastText:last?.textContent||'',
          bodyWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),viewport:document.documentElement.clientWidth};
      })())`));
      assert.equal(result.cardName, '0.9.4: Restructure for Speed and Cost', `${width}: the release uses the shared named header`);
      assert.equal(result.itemCount, 0, `${width}: the shared header replaces the extra item-count line`);
      assert.ok(result.pace.top >= result.name.bottom - 1, `${width}: pace appears beneath the release name`);
      if (width === 1280) assert.ok(result.pace.height <= result.paceLineHeight + 1 && result.paceFits, `desktop pace stays on one shared header line without clipping: ${JSON.stringify({ rect: result.pace, lineHeight: result.paceLineHeight, fits: result.paceFits })}`);
      const rowsById = new Map(result.rows.map(row => [row.id, row]));
      assert.equal(rowsById.size, 5, `${width}: the release shows each of its five items once`);
      assert.deepEqual(['#1', '#2', '#3', '#4', '#5'].map(id => rowsById.get(id)?.label), ['Ready', 'Gated', 'Building', 'In review', 'Ready'], `${width}: each item shows its approved plain lifecycle stage`);
      // The shared stage model shows a returned item as Ready with a sent-back mark, not a Sent back stage.
      assert.deepEqual(['#1', '#2', '#3', '#4', '#5'].map(id => rowsById.get(id)?.back), [false, false, false, false, true], `${width}: only the returned item carries the sent-back mark`);
      assert.equal(queuePositionById.size, 5, `${width}: the roadmap API gives every release item a queue position`);
      assert.deepEqual(['#1', '#2', '#3', '#4', '#5'].map(id => rowsById.get(id)?.order), ['#1', '#2', '#3', '#4', '#5'].map(id => queuePositionById.get(id)), `${width}: each item shows its authoritative queue position`);
      assert.ok(result.rows.every(row => row.icon && row.titleLines === 1), `${width}: each row has a state icon and one-line title`);
      const dependent = result.rows.find(row => row.id === '#2');
      assert.equal(dependent.after, 'after #1', `${width}: the dependency is shown quietly after its title`);
      assert.match(dependent.afterHref, /items\/1/u, `${width}: the after reference remains a link to the prerequisite`);
      assert.equal(dependent.blockDots, 0, `${width}: the dependency has no bare red dot`);
      assert.ok(result.releases.length >= 1 && result.releases.every(release => release.progress), `${width}: each upcoming release has a progress bar`);
      for (const release of result.releases) {
        const [done, total] = release.count.split('/').map(Number);
        const viewWidth = Number(release.progress.viewBox.split(' ')[2]);
        const filled = Number(release.progress.rect);
        assert.equal(filled / viewWidth, total ? done / total : 0, `${width}: ${release.name} progress matches its count`);
      }
      const current = result.releases.find(release => release.name.startsWith('0.9.4'));
      assert.ok(current, `${width}: the Releases panel names the current release`);
      assert.equal(current.count, '0/5', `${width}: the current release shows its landed count over total`);
      assert.deepEqual(result.shipping.map(entry => entry.label), ['Landed', 'Accepted, landing', 'In review', 'Building', 'Waiting', 'Held'], `${width}: Shipping keeps all six counts in its two-column grid`);
      assert.equal(result.shippingColumns, 2, `${width}: the six Shipping counts remain in two columns`);
      assert.ok(result.shipping.every(entry => entry.swatch === entry.headerSwatch), `${width}: each Shipping dot matches its release bar segment color`);
      assert.deepEqual(result.last, ['Last shipped', '0.9.3', shippedDate], `${width}: Last shipped names the release and recorded npm date`);
      assert.doesNotMatch(result.lastText, /PRIVATE shipment note/u, `${width}: Last shipped never exposes the raw note`);
      assert.ok(result.bodyWidth <= result.viewport, `${width}: the Roadmap has no sideways page overflow`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
