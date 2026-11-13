// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap blocked rows: plain prose and the remote blocker on a phone [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { blockedRoadmap } from '../../../tests/fixtures/cockpit/blocked-roadmap.js';

test('a blocked roadmap item reads its prose plainly and its remote blocker on a phone [N26]', { timeout: 150_000 }, async (t) => {
  const began = performance.now();
  /** Name each stage boundary and its elapsed time, so a slow run reads as a diagnosis. */
  const stage = phase => console.log('roadmap-remote-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const { chrome, row, opened, reads, address, close } = await blockedRoadmap(t, stage);
  try {
    for (const width of [375,1280]) for (const scheme of ['light','dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await chrome.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
      for (const [id,field] of [['#2','.roadmap-criterion'],['#6','.roadmap-return']]) {
        await opened(id);
        const prose=JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row(id)}.parentElement.querySelector('.milestone-why'),value=panel.querySelector(${JSON.stringify(field)});return {text:value.textContent,chips:value.querySelectorAll('.roadmap-ref').length,links:panel.querySelectorAll('a').length};})())`));
        assert.match(prose.text,/#1 and #3/u,`${width}/${scheme}: ${field} keeps its literal references`);
        assert.equal(prose.chips,0,'the clarified bar keeps prose references plain');assert.equal(prose.links,1,'only Open in Items is a link');
        assert.equal(await chrome.stable('location.href'),address);assert.equal(await chrome.stable('view.tab'),'roadmap');
        await press(chrome,row(id));
      }
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', {width:375,height:900,deviceScaleFactor:1,mobile:false});
    const remote = await opened('blocked-roadmap-other#2');
    assert.match(remote, /Blocked by#1 unclaimed/u); assert.match(remote, /Review the remote dependency/u);
    assert.match(remote, /Sent back.*Remote latest finding/u); assert.doesNotMatch(remote, /More detail stays in Items/u);
    const metrics = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const r=${row('blocked-roadmap-other#2')},d=r.querySelector('.roadmap-after').getBoundingClientRect(),t=r.querySelector('.t').getBoundingClientRect();return {visible:d.width>0&&d.left>=t.left&&d.right<=t.right,after:[d.left,d.right,d.width],title:[t.left,t.right],columns:getComputedStyle(r).gridTemplateColumns,children:[...r.children].map(k=>[String(k.className).slice(0,30),Math.round(k.getBoundingClientRect().width)]),row:r.getBoundingClientRect().width,text:r.querySelector('.t').textContent,width:document.documentElement.scrollWidth,viewport:innerWidth};})())`));
    assert.ok(metrics.visible, `the remote blocker mark stays visible on a phone: ${JSON.stringify(metrics)}`); assert.ok(metrics.width<=metrics.viewport);
    await press(chrome, `${row('blocked-roadmap-other#2')}.parentElement.querySelector('.milestone-why a[data-go]')`);
    await chrome.waitFor("view.tab==='items' && document.querySelector('#detail h2')?.textContent.includes('Remote sent-back work')");
    assert.equal(await chrome.stable("document.querySelector('#proj-name').textContent"), 'blocked-roadmap-other');
    assert.deepEqual(chrome.exceptions, []);
  } finally { await close(); }
});
