// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap blocked rows: dot and expansion [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { blockedRoadmap } from '../../../tests/fixtures/cockpit/blocked-roadmap.js';

test('a blocked roadmap item shows its dot and expands to say why [N26]', { timeout: 150_000 }, async (t) => {
  const began = performance.now();
  /** Name each stage boundary and its elapsed time, so a slow run reads as a diagnosis. */
  const stage = phase => console.log('roadmap-blocked-stage ' + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - began) }));
  const { chrome, row, opened, reads, address, close } = await blockedRoadmap(t, stage);
  try {
    stage('first-open');
    const blocked = await opened('#2');
    assert.match(blocked, /CriterionUse #1 and #3 <em>literally<\/em>\./u, 'the approved dense detail leads with the criterion');
    assert.doesNotMatch(blocked, /More detail stays in Items/u, 'only the first criterion sentence is shown');
    assert.deepEqual(JSON.parse(await chrome.stable(`JSON.stringify([...${row('#2')}.parentElement.querySelectorAll('.roadmap-criterion .roadmap-ref')].map(chip=>chip.textContent))`)), [], 'references inside Criterion stay plain text');
    assert.equal(await chrome.stable(`${row('#2')}.parentElement.querySelectorAll('.roadmap-criterion em').length`),0,'criterion markup stays escaped');
    assert.match(blocked, /Blocked by#1 building.*web-2.*since/u, 'dependency includes state, holder and local time');
    assert.match(blocked, /History.*added/u); assert.match(blocked, /Release.*Next.*G1/u);
    // The other board also has an item #2, so only this board's reads count.
    const local = await chrome.stable('boardPath(view.root)');
    assert.ok((await reads()).filter(url => url.endsWith(local + '/items/2')).length <= 1, 'the first opened row reads its detail once, ahead or on expand');
    stage('rows-open');
    for (const id of ['#2', '#6', '#5']) {
      if (id !== '#2') await opened(id);
      const text = await chrome.stable(`${row(id)}.parentElement.querySelector('.milestone-why').textContent`);
      if (id === '#6') {
        assert.match(text, /Agents.*web-1.*building/u); assert.match(text, /Sent back.*coordinator.*See #1 and #3 before accepting/u);
        assert.match(text, /History.*claimed.*submitted.*sent back.*claimed again/u);
      }
      if (id === '#5') { assert.match(text, /Agents.*web-1.*built.*coordinator.*verified/u); assert.match(text, /History.*accepted.*landed/u); }
      const before = await reads();
      await press(chrome, row(id));
      await chrome.stable(`${row(id)}.focus();true`);
      await chrome.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
      await chrome.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 });
      await chrome.waitFor(`${row(id)}.getAttribute('aria-expanded')==='true'`);
      assert.deepEqual(await reads(), before, 'reopening keeps the shared item-detail cache');
      assert.equal(await chrome.stable('location.href'), address); assert.equal(await chrome.stable('view.tab'), 'roadmap');
      await press(chrome, row(id));
    }
    const base = await opened('#1');
    assert.match(base, /Blocks.*#2 unclaimed/u, 'the dense row names its open dependants');
    assert.match(base, /Blocks.*#4 sent back/u, 'a sent-back dependant keeps its status');
    assert.equal(await chrome.stable(`${row('#1')}.parentElement.querySelectorAll('.milestone-why a').length`), 1, 'references are chips; only the explicit Items link navigates');
    await press(chrome, row('#1'));
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-color-scheme',value:scheme}] });
      await opened('#6');
      const style = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row('#6')}.parentElement.querySelector('.milestone-why');const label=panel.querySelector('dt'),value=label.nextElementSibling;return {icons:panel.querySelectorAll('dt svg').length, labels:panel.querySelectorAll('dt').length,top:getComputedStyle(label).alignSelf,chip:getComputedStyle(panel.querySelector('.roadmap-step.no')).backgroundColor,danger:getComputedStyle(panel.querySelector('.roadmap-return')).backgroundColor,labelTop:label.getBoundingClientRect().top,valueTop:value.getBoundingClientRect().top};})())`));
      assert.equal(style.icons, style.labels, `${scheme}: every label has an inline icon`);
      assert.equal(style.top, 'start', `${scheme}: labels stay at the first value line`);
      assert.ok(Math.abs(style.labelTop-style.valueTop)<2, `${scheme}: wrapped values keep their top-aligned label`);
      assert.notEqual(style.danger, 'rgba(0, 0, 0, 0)', `${scheme}: send-back reason is tinted`);
      const colors = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const panel=${row('#6')}.parentElement.querySelector('.milestone-why');const probe=document.createElement('span');panel.append(probe);probe.style.color='var(--mark-back)';const danger=getComputedStyle(probe).color;probe.style.color='color-mix(in oklab, var(--mark-back) 60%, var(--ink))';const callout=getComputedStyle(probe).color;probe.style.color='var(--stage-merged)';const success=getComputedStyle(probe).color;probe.remove();return {danger,callout,success,reject:getComputedStyle(panel.querySelector('.roadmap-step.no')).backgroundColor,reason:getComputedStyle(panel.querySelector('.roadmap-return')).color};})())`));
      assert.equal(colors.reject, colors.danger, `${scheme}: send-back history uses the back-edge token (--mark-back, as the stylesheet and colors.test.js ship it)`);
      assert.equal(colors.reason, colors.callout, `${scheme}: the callout reads the back-edge token mixed toward the ink, as .chip.no does`);
      await press(chrome, row('#6'));
      await opened('#5');
      const landed = JSON.parse(await chrome.stable(`JSON.stringify((()=>{const r=${row('#5')},panel=r.parentElement.querySelector('.milestone-why');return {color:getComputedStyle(panel.querySelector('.roadmap-event:last-child .roadmap-step')).backgroundColor,stage:r.querySelector('.stage-word')?.textContent,icon:!!r.querySelector('.roadmap-landed svg')};})())`));
      assert.equal(landed.color, colors.success, `${scheme}: landing history uses the merged-stage token (--stage-merged)`);
      assert.equal(landed.stage, 'Landed'); assert.equal(landed.icon, false, 'a landed row reads Landed, with no checkmark');
      await press(chrome, row('#5'));
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally { await close(); }
});
