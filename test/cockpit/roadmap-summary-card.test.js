// pullboard: browser
/** @pullboard-test-gui */
/** Render the real roadmap card with explicit summary presentation values at phone and desktop widths [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from './fixture.js';
import { project } from './fixture.js';
import { startView } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { press } from './fixture.js';

test('a roadmap summary card separates its counts, legend and forecast at phone and desktop widths [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the rendered roadmap summary card.');
  const box = machine(), alpha = project(box, 'roadmap-summary-card');
  box.run(alpha.repo, 'add', 'web', 'Capacity work', '--specs', 'G1', '--criterion', 'The page renders.');
  box.run(alpha.repo, 'milestone', 'add', 'Capacity', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'edit', 'Capacity', '--limit', '2');
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
    // The completion estimate names a part of day in the browser's zone, so pin it; the machine's zone shifts at DST.
    await chrome.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
    // This is a presenter-only scenario; the native API input above remains separately checked as real board data.
    await chrome.stable("(()=>{const m=data.project.milestones.find(milestone=>milestone.name==='Capacity');data.project.observedAt='2026-10-28T12:00:00Z';m.count=512;m.limit=700;m.summary={total:512,left:512,landed:0,landing:7,review:0,building:0,waiting:493,held:12,needsYou:[],pace:{last6h:7,last2h:7},estimate:{low:71,high:212.5},window:'6h',reason:null};render();return true;})()");
    for (const width of [320, 375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const scheme of ['light', 'dark']) {
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        const label = await chrome.stable("document.querySelector('[data-key=\"m:Capacity\"] .milestone-limit')?.textContent||''");
        assert.equal(label, '', `${width}/${scheme}: the shared release header replaces the extra total-and-limit line`);
        const card = JSON.parse(await chrome.stable("JSON.stringify((()=>{const m=document.querySelector('[data-key=\"m:Capacity\"]'),entries=[...m.querySelectorAll('[data-summary-state]')],held=entries.at(-1),forecast=m.querySelector('.roadmap-forecast'),rate=m.querySelector('.roadmap-estimate'),pace=m.querySelector('.roadmap-pace'),completion=m.querySelector('.roadmap-completion'),legend=m.querySelector('.roadmap-summary-legend');return {text:m.textContent,legend:entries.map(x=>x.textContent.trim()),legendWrap:getComputedStyle(legend).flexWrap,rows:entries.map(x=>{const r=x.getBoundingClientRect();return {top:r.top,center:r.top+r.height/2};}),heldHeight:held.getBoundingClientRect().height,heldColor:getComputedStyle(held).color,colors:[...new Set(entries.map(x=>getComputedStyle(x).color))],alignment:entries.map(entry=>{const nodes=[...entry.children],style=getComputedStyle(entry),centers=nodes.map(node=>{const r=node.getBoundingClientRect();return r.top+r.height/2;});return {display:style.display,alignItems:style.alignItems,tags:nodes.map(node=>node.tagName),weight:getComputedStyle(nodes[1]).fontWeight,centers,centered:centers.every(center=>Math.abs(center-centers[0])<.75)};}),forecast:{rate:rate.textContent,pace:pace.textContent,completion:completion.textContent,rateBold:rate.querySelectorAll('b').length,paceBold:pace.querySelectorAll('b').length,display:getComputedStyle(forecast).display}};})())"));
        assert.match(card.text, /512 to go/u);
        assert.doesNotMatch(card.text, /limit 700/u);
        assert.deepEqual(card.legend, ['0 landed', '7 accepted, landing', '0 in review', '0 building', '493 waiting', '12 held'], `${width}/${scheme}: legend text keeps a real space before each label`);
        assert.ok(card.alignment.every(entry => ['flex', 'inline-flex'].includes(entry.display) && entry.alignItems === 'center' && Number(entry.weight) >= 600 && entry.tags.join(',') === 'I,B,SPAN' && entry.centered),
          `${width}/${scheme}: every legend entry aligns a dot, bold count and label: ${JSON.stringify(card.alignment)}`);
        assert.equal(card.colors.length, 1, `${width}/${scheme}: the held control shares the legend text color`);
        assert.ok(card.heldHeight >= (width < 900 ? 44 : 32), `${width}/${scheme}: the held control keeps its ${width < 900 ? 44 : 32}px target`);
        assert.equal(card.legendWrap, 'wrap', `${width}/${scheme}: long key labels wrap when their container requires it`);
        assert.deepEqual(card.forecast, { rate: '1.2 items an hour', pace: '7 landed in the last 6 h, 7 in the last 2 h',
          completion: 'done in about 6 days, Tuesday morning', rateBold: 0, paceBold: 0, display: 'block' }, `${width}/${scheme}: the shared line retains its rate, actual counts and completion estimate`);
      }
    }
    await chrome.stable("(()=>{const m=data.project.milestones.find(milestone=>milestone.name==='Capacity');m.summary={...m.summary,estimate:null,pace:null,reason:null,needsYou:[]};render();return true;})()");
    const unavailable=JSON.parse(await chrome.stable("JSON.stringify((()=>{const m=document.querySelector('[data-key=\"m:Capacity\"]');return {rate:m.querySelector('.roadmap-estimate')?.textContent||'',pace:m.querySelector('.roadmap-pace')?.textContent||'',completion:m.querySelector('.roadmap-completion')?.textContent||'',needs:m.querySelectorAll('.roadmap-summary-needs').length};})())"));
    assert.deepEqual(unavailable,{rate:'— items an hour',pace:'— landed in the last 6 h, — in the last 2 h',completion:'completion time unavailable',needs:0},'missing summary values remain explicit rather than disappearing or becoming zero');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
