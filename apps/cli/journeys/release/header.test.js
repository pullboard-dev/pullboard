// pullboard: browser
/** @pullboard-test-gui */
/** The Dashboard's Release card and the Roadmap's release header, each as approved, in real Chrome [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept } from '../../tests/fixtures/cockpit/harness.js';
import { build } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { press } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { pickProject } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';

/** Seed one release and read it on both view surfaces in real Chrome. */
test('Dashboard Release and the Roadmap release header read the same release at desktop and phone widths [N26]', { timeout: 180_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the release header journey.');
  const box = machine(), alpha = project(box, 'release-header');
  for (let id = 1; id <= 5; id++) {
    await box.inProcess(alpha.repo, 'add', 'web', 'Release header item ' + id, '--specs', 'G1', '--criterion', 'The shared release header remains readable.');
    if (id > 3) continue;
    build(box, alpha, id, `release-${id}.txt`);
    accept(box, alpha, id);
    box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
    await box.inProcess(alpha.repo, 'merged', String(id), box.git(alpha.repo, 'rev-parse', 'HEAD'));
  }
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.9.4: Restructure for Speed and Cost', '--items', '1,2,3,4,5', '--reason', 'the fixture places its own items');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-release-header-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && data.project.milestones?.some(m => m.name === '0.9.4: Restructure for Speed and Cost')`);
    for (const width of [1280, 320]) {
      await press(chrome, "document.querySelector('[data-tab=dashboard]')");
      await chrome.waitFor("document.querySelector('#dashboard .dash-ship .dash-ship-name')");
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // The Dashboard draws the approved Release card (#6646, #6847); the Roadmap keeps its own release header.
      const dashboard = JSON.parse(await chrome.stable("JSON.stringify((()=>{const c=document.querySelector('#dashboard .dash-ship'),name=c.querySelector('.dash-ship-name'),bar=c.querySelector('.dash-sbar'),keys=c.querySelector('.dash-keys'),box=n=>{const r=n.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height)}};return {eyebrow:c.closest('section').querySelector('.dash-shd h2').textContent,eyebrowShown:getComputedStyle(c.closest('section').querySelector('.dash-shd h2')).textTransform,name:name.textContent,nameFont:getComputedStyle(name).fontFamily,nameSize:getComputedStyle(name).fontSize,nameCase:getComputedStyle(name).textTransform,left:c.querySelector('.dash-togo').textContent,bars:c.querySelectorAll('.dash-sbar').length,bar:box(bar),keys:box(keys),keysBelow:keys.getBoundingClientRect().top>=bar.getBoundingClientRect().bottom,tiles:[...c.querySelectorAll('[data-dashboard-tile] .dash-stat-k')].map(n=>n.textContent),overflow:document.documentElement.scrollWidth>innerWidth};})())"));
      assert.equal(dashboard.eyebrow, 'Release');
      assert.equal(dashboard.eyebrowShown, 'uppercase', 'the header above the card reads RELEASE (sheet v1.1)');
      assert.equal(dashboard.name, '0.9.4Restructure for Speed and Cost', 'the version, then the release name');
      assert.doesNotMatch(dashboard.nameFont, /mono/iu, 'the release name is in the body face');
      assert.equal(dashboard.nameCase, 'none', 'the release name is never set in capitals');
      assert.equal(dashboard.nameSize, '17px');
      assert.equal(dashboard.left, '2 to go3 of 5 landed');
      assert.equal(dashboard.bars, 1, 'one stage bar');
      assert.ok(dashboard.bar.width > 0 && dashboard.keys.width > 0 && dashboard.keysBelow, `${width}px the legend sits under the bar`);
      assert.deepEqual(dashboard.tiles, ['Today’s pace', 'Right now', 'ETA']);
      assert.equal(dashboard.overflow, false, `${width}px Dashboard has no horizontal overflow`);
      // The bar and its legend paint in the formal stage colours (Waiting is the sheet's grey): each segment and its swatch resolve to the same token.
      const colours = JSON.parse(await chrome.stable("JSON.stringify((()=>{const c=document.querySelector('#dashboard .dash-ship'),probe=document.createElement('i');c.append(probe);const token=name=>{probe.style.color='var(--'+name+')';return getComputedStyle(probe).color;};const out={};for(const [key,name] of [['landed','stage-merged'],['waiting','waiting']]){out[key]={token:token(name),fill:getComputedStyle(c.querySelector('rect.dash-seg-'+key)).fill,swatch:getComputedStyle(c.querySelector('i.dash-seg-'+key)).backgroundColor};}probe.remove();return out;})())"));
      for (const [key, seen] of Object.entries(colours)) {
        assert.equal(seen.fill, seen.token, `${width}px the ${key} segment is its stage colour`);
        assert.equal(seen.swatch, seen.token, `${width}px the ${key} legend swatch is its stage colour`);
      }

      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      await chrome.waitFor("document.querySelector('#roadmap .release-header .release-name')");
      const roadmap = JSON.parse(await chrome.stable("JSON.stringify((()=>{const h=document.querySelector('#roadmap .release-header'),top=h.querySelector('.release-header-top'),title=top.querySelector('.release-name'),left=top.querySelector('.roadmap-left'),line=top.querySelector('.roadmap-forecast'),bar=h.querySelector('.roadmap-summary-bar'),legend=h.querySelector('.roadmap-summary-legend'),box=n=>{const r=n.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height)}},br=bar.getBoundingClientRect(),lr=legend.getBoundingClientRect();return {title:title.textContent,line:line.textContent.replace(/\\s+/g,' ').trim(),left:left.textContent.replace(/\\s+/g,' ').trim(),leftLabel:left.querySelector('[aria-label]').getAttribute('aria-label'),font:getComputedStyle(title).fontSize,header:box(h),top:box(top),lineBox:box(line),bar:box(bar),legend:box(legend),rowAligned:bar.closest('.roadmap-summary-row')===legend.closest('.roadmap-summary-row')&&lr.top>=br.bottom&&lr.left<br.right,carets:h.querySelectorAll('.release-header-toggle > .caret').length,limit:h.querySelector('.milestone-limit')?.textContent||'',overflow:document.documentElement.scrollWidth>innerWidth};})())"));
      assert.equal(roadmap.title, '0.9.4: Restructure for Speed and Cost');
      assert.match(roadmap.line, /^0\.5 items an hour · 3 landed in the last 6 h, 3 in the last 2 h · done in about 3 hours, /u);
      assert.equal(roadmap.left, '2 to go3 of 5 landed');
      assert.equal(roadmap.leftLabel, '3/5 landed');
      assert.equal(roadmap.carets, 1, 'Roadmap keeps its release disclosure caret');
      assert.equal(roadmap.limit, '', 'Roadmap removes the extra total-items label');
      assert.equal(roadmap.overflow, false, `${width}px Roadmap has no horizontal overflow`);
      // The approved Roadmap mockup stacks the state key under the bar (96ebc863f2): one summary row, key below the bar and under its width.
      assert.ok(roadmap.rowAligned, `${width}px the Roadmap state key sits directly under the progress bar in the same summary row`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
