// pullboard: browser
/** @pullboard-test-gui */
/** The Dashboard and Roadmap share the approved release headline in real Chrome [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept } from './fixture.js';
import { build } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { machine } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { press } from './fixture.js';
import { project } from './fixture.js';
import { pickProject } from './fixture.js';
import { startView } from './fixture.js';

/** Seed one release and compare its shared headline in real Chrome across both view surfaces. */
test('Dashboard and Roadmap share the approved release headline at desktop and phone widths [N26]', { timeout: 180_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the release header journey.');
  const box = machine(), alpha = project(box, 'release-header');
  for (let id = 1; id <= 5; id++) {
    box.run(alpha.repo, 'add', 'web', 'Release header item ' + id, '--specs', 'G1', '--criterion', 'The shared release header remains readable.');
    if (id > 3) continue;
    build(box, alpha, id, `release-${id}.txt`);
    accept(box, alpha, id);
    box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
    box.run(alpha.repo, 'merged', String(id), box.git(alpha.repo, 'rev-parse', 'HEAD'));
  }
  box.run(alpha.repo, 'milestone', 'add', '0.9.4: Restructure for Speed and Cost', '--items', '1,2,3,4,5', '--reason', 'the fixture places its own items');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-release-header-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && data.project.milestones?.some(m => m.name === '0.9.4: Restructure for Speed and Cost')`);
    for (const width of [1280, 320]) {
      await press(chrome, "document.querySelector('[data-tab=dashboard]')");
      await chrome.waitFor("document.querySelector('#dashboard .dash-release-card .release-header')");
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const dashboard = JSON.parse(await chrome.stable("JSON.stringify((()=>{const h=document.querySelector('#dashboard .release-header'),top=h.querySelector('.release-header-top'),title=top.querySelector('.release-name'),left=top.querySelector('.roadmap-left'),line=top.querySelector('.roadmap-forecast'),bar=h.querySelector('.roadmap-summary-bar'),legend=h.querySelector('.roadmap-summary-legend'),box=n=>{const r=n.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height)}},br=bar.getBoundingClientRect(),lr=legend.getBoundingClientRect();return {title:title.textContent,line:line.textContent.replace(/\\s+/g,' ').trim(),left:left.textContent.replace(/\\s+/g,' ').trim(),leftLabel:left.querySelector('[aria-label]').getAttribute('aria-label'),font:getComputedStyle(title).fontSize,header:box(h),top:box(top),lineBox:box(line),bar:box(bar),legend:box(legend),rowAligned:bar.closest('.roadmap-summary-row')===legend.closest('.roadmap-summary-row')&&br.right<=lr.left&&br.bottom>lr.top&&lr.bottom>br.top,carets:h.querySelectorAll('.caret').length,visibleLabel:document.querySelector('#dashboard .dash-release-card > h2')?.textContent||'',oldStats:document.querySelector('#dashboard .dash-stats')!==null,overflow:document.documentElement.scrollWidth>innerWidth};})())"));
      assert.equal(dashboard.title, '0.9.4: Restructure for Speed and Cost');
      assert.match(dashboard.line, /^0\.5 items an hour · 3 landed in the last 6 h, 3 in the last 2 h · done in about 3 hours, /u);
      assert.equal(dashboard.left, '2 to go3 of 5 landed');
      assert.equal(dashboard.leftLabel, '3/5 landed');
      assert.equal(dashboard.font, '17px');
      assert.equal(dashboard.carets, 0, 'Dashboard has no Roadmap disclosure caret');
      assert.equal(dashboard.visibleLabel, '', 'Dashboard has no separate Shipping now label');
      assert.equal(dashboard.oldStats, false, 'the old pace boxes are removed');
      assert.equal(dashboard.overflow, false, `${width}px Dashboard has no horizontal overflow`);
      assert.ok(dashboard.bar.width > 0 && dashboard.legend.width > 0, `${width}px header retains both progress bar and state key`);

      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      await chrome.waitFor("document.querySelector('#roadmap .release-header .release-name')");
      const roadmap = JSON.parse(await chrome.stable("JSON.stringify((()=>{const h=document.querySelector('#roadmap .release-header'),top=h.querySelector('.release-header-top'),title=top.querySelector('.release-name'),left=top.querySelector('.roadmap-left'),line=top.querySelector('.roadmap-forecast'),bar=h.querySelector('.roadmap-summary-bar'),legend=h.querySelector('.roadmap-summary-legend'),box=n=>{const r=n.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height)}},br=bar.getBoundingClientRect(),lr=legend.getBoundingClientRect();return {title:title.textContent,line:line.textContent.replace(/\\s+/g,' ').trim(),left:left.textContent.replace(/\\s+/g,' ').trim(),leftLabel:left.querySelector('[aria-label]').getAttribute('aria-label'),font:getComputedStyle(title).fontSize,header:box(h),top:box(top),lineBox:box(line),bar:box(bar),legend:box(legend),rowAligned:bar.closest('.roadmap-summary-row')===legend.closest('.roadmap-summary-row')&&br.right<=lr.left&&br.bottom>lr.top&&lr.bottom>br.top,carets:h.querySelectorAll('.release-header-toggle > .caret').length,limit:h.querySelector('.milestone-limit')?.textContent||'',overflow:document.documentElement.scrollWidth>innerWidth};})())"));
      assert.deepEqual([roadmap.title, roadmap.line, roadmap.left, roadmap.leftLabel, roadmap.font],
        [dashboard.title, dashboard.line, dashboard.left, dashboard.leftLabel, dashboard.font], `${width}px both surfaces show the same native release facts`);
      assert.equal(roadmap.carets, 1, 'Roadmap keeps its release disclosure caret');
      assert.equal(roadmap.limit, '', 'Roadmap removes the extra total-items label');
      assert.equal(roadmap.overflow, false, `${width}px Roadmap has no horizontal overflow`);
      assert.equal(roadmap.bar.height, dashboard.bar.height, `${width}px progress bars share their geometry`);
      assert.ok(dashboard.rowAligned && roadmap.rowAligned, `${width}px each state key shares its aligned row with the progress bar`);
      assert.ok(
        Math.abs(roadmap.bar.width / (roadmap.bar.width + roadmap.legend.width)
          - dashboard.bar.width / (dashboard.bar.width + dashboard.legend.width)) < 0.01,
        `${width}px the bar and key keep the same relative widths in their natural containers`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
