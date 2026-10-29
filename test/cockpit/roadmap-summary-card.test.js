/** @pullboard-test-gui */
/** Render the real roadmap card with explicit summary presentation values at phone and desktop widths [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

test('a roadmap summary card separates its counts, legend and forecast at phone and desktop widths [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the rendered roadmap summary card.');
  const box = machine(), alpha = project(box, 'roadmap-summary-card');
  box.run(alpha.repo, 'add', 'web', 'Capacity work', '--specs', 'G1', '--criterion', 'The page renders.');
  box.run(alpha.repo, 'milestone', 'add', 'Capacity', '--items', '1', '--limit', '2');
  const api = JSON.parse(box.run(alpha.repo, 'roadmap', '--json'));
  const actual = api.milestones.find(milestone => milestone.name === 'Capacity');
  assert.ok(actual, 'the milestone comes from the real roadmap API');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-summary-card-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.milestones?.some(milestone => milestone.name === 'Capacity')");
    const live = JSON.parse(await chrome.stable("JSON.stringify(data.project.milestones.find(milestone => milestone.name === 'Capacity'))"));
    assert.deepEqual(live.summary, actual.summary, 'the initial card input is the summary from the real API');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("document.querySelector('[data-key=\"m:Capacity\"] .milestone-head')");
    // This is a presenter-only scenario; the native API input above remains separately checked as real board data.
    await chrome.stable("(()=>{const m=data.project.milestones.find(milestone=>milestone.name==='Capacity');m.count=512;m.limit=700;m.summary={total:512,left:512,landed:0,landing:7,review:0,building:0,waiting:493,held:12,needsYou:[],pace:{last6h:7,last2h:7},estimate:{low:71,high:212.5},window:'6h',reason:null};render();return true;})()");
    for (const width of [320, 375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const scheme of ['light', 'dark']) {
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        const label = await chrome.stable("document.querySelector('[data-key=\"m:Capacity\"] .milestone-limit')?.textContent");
        assert.equal(label, '512 items', `${width}/${scheme}: the distant 700-item limit is hidden`);
        const card = JSON.parse(await chrome.stable("JSON.stringify((()=>{const m=document.querySelector('[data-key=\"m:Capacity\"]'),entries=[...m.querySelectorAll('[data-summary-state]')],held=entries.at(-1),forecast=m.querySelector('.roadmap-forecast'),estimate=m.querySelector('.roadmap-estimate'),pace=m.querySelector('.roadmap-pace');return {text:m.textContent,legend:entries.map(x=>x.textContent.trim()),rows:entries.map(x=>{const r=x.getBoundingClientRect();return {top:r.top,center:r.top+r.height/2};}),heldHeight:held.getBoundingClientRect().height,heldColor:getComputedStyle(held).color,colors:[...new Set(entries.map(x=>getComputedStyle(x).color))],aligned:entries.every(entry=>{const nodes=[...entry.children],centers=nodes.map(node=>{const r=node.getBoundingClientRect();return r.top+r.height/2;});return getComputedStyle(entry).display==='inline-flex'&&getComputedStyle(entry).alignItems==='center'&&Number(getComputedStyle(nodes[1]).fontWeight)>=600&&nodes.map(node=>node.tagName).join(',')==='I,B,SPAN'&&centers.every(center=>Math.abs(center-centers[0])<.75);}),forecast:{estimate:estimate.textContent,pace:pace.textContent,estimateBold:estimate.querySelectorAll('b').length,paceBold:pace.querySelectorAll('b').length,separate:pace.getBoundingClientRect().top>estimate.getBoundingClientRect().top,display:getComputedStyle(forecast).display}};})())"));
        assert.match(card.text, /512 items/u);
        assert.doesNotMatch(card.text, /limit 700/u);
        assert.deepEqual(card.legend, ['0 landed', '7 accepted, landing', '0 in review', '0 building', '493 waiting', '12 held'], `${width}/${scheme}: legend text keeps a real space before each label`);
        assert.equal(card.aligned, true, `${width}/${scheme}: every legend entry aligns a dot, bold count and label`);
        assert.equal(card.colors.length, 1, `${width}/${scheme}: the held control shares the legend text color`);
        assert.ok(card.heldHeight >= (width < 900 ? 44 : 32), `${width}/${scheme}: the held control keeps its ${width < 900 ? 44 : 32}px target`);
        if (width === 1280) assert.equal(new Set(card.rows.map(row => row.top)).size, 1, 'desktop legend entries share one row');
        assert.deepEqual(card.forecast, { estimate: 'About 3 to 9 days at today’s pace', pace: '7 landed in the last 6 h, 7 in the last 2 h',
          estimateBold: 2, paceBold: 2, separate: true, display: 'grid' }, `${width}/${scheme}: forecast facts are separated and key numbers are bold`);
      }
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
