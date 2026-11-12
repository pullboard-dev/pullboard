// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: pointer, phone and chevron release jumps, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  build,
  startView,
  target,
  accept,
  chromeExecutable,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

test('a refresh between pointer down and up preserves a roadmap release click [N26,C7]', {
  timeout: 90_000, // budget: hang ceiling for real board setup, Chrome and two pointer-held board refreshes.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Roadmap refresh control.');
  const box = machine(), demo = project(box, 'roadmap-refresh-press');
  for (const name of ['0.8.7','0.8.8','0.8.9','0.8.10','0.8.11','0.8.12','0.8.13','0.8.14']) {
    box.run(demo.repo, 'milestone', 'add', name, '--note', 'Release navigation control.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-refresh-press-'));
  let chrome, trace;
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 8');
    for (const width of [375,1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false });
      await press(chrome, "document.querySelector('[data-tab=roadmap]')");
      const key = 'm:0.8.7';
      trace = await watchRoadmapPress(chrome, key);
      const message = `roadmap refresh while pointer held ${width}`;
      let held;
      await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]')`, {
        afterMouseDown: async () => {
          box.run(demo.repo, 'shout', 'person', message);
          await chrome.waitFor(`data.project.shouts.some(shout => shout.shout_text === ${JSON.stringify(message)})`);
          held = await trace.snapshot();
          t.diagnostic(`${width}: held refresh: ${JSON.stringify(held)}`);
        },
      });
      await chrome.waitFor(`!deferredClickRender && data.project.shouts.some(shout => shout.shout_text === ${JSON.stringify(message)})`);
      const released = await trace.snapshot();
      t.diagnostic(`${width}: released: ${JSON.stringify(released)}`);
      assert.ok(held.samples.some(sample => sample.phase === 'after render'), `${width}: the real board refresh attempted a render while held`);
      assert.ok(held.samples.at(-1).connected && held.samples.at(-1).same, `${width}: the pressed button survives the refresh`);
      assert.ok(held.samples.at(-1).deferred, `${width}: the render waits until the pointer release`);
      assert.ok(released.events.some(event => event.type === 'click' && event.key === key), `${width}: the release produces the intended native click`);
      const reached = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const target=document.querySelector('#roadmap-list [data-key="${key}"]'), r=target.getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,bar:document.querySelector('.top').getBoundingClientRect().bottom,
          current:document.querySelector('#roadmap-panel [data-roadmap-jump="${key}"]').getAttribute('aria-current')};
      })())`));
      assert.ok(reached.bottom > reached.bar && reached.top < 900, `${width}: the selected release is visible: ${JSON.stringify(reached)}`);
      assert.equal(reached.current, 'location', `${width}: the panel marks the selected release`);
      await trace.dispose(); trace = null;
    }
  } finally {
    try { if (trace) await trace.dispose(); }
    finally {
      try { if(chrome) await closeSnapshotChrome(chrome); }
      finally { try { await view.stop(); } finally { rmSync(profile,{recursive:true,force:true}); } }
    }
  }
});

test('a release jump on a phone leaves its heading below the top bar [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for phone release-jump checks.');
  const box = machine();
  const alpha = project(box, 'roadmap-phone-release-jump');
  for (const title of ['First release item', 'Second release item']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'milestone', 'add', '0.9.0', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.9.1', '--reason', 'Arrange fixture release', '--items', '2');
  for (const name of ['0.9.2', '0.9.3', '0.9.4', '0.9.5', '0.9.6', '0.9.7', '0.9.8', '0.9.9', '0.9.10', '0.9.11']) {
    box.run(alpha.repo, 'milestone', 'add', name, '--note', 'Later release.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-phone-jump-'));
  let chrome;
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 12');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.stable(`(() => {
      window.__roadmapJump = [];
      const observer = new MutationObserver(records => {
        const target = document.querySelector('#roadmap-list [data-key="m:0.9.1"]');
        window.__roadmapJump.push({ arrival: target?.classList.contains('roadmap-arrival') ?? null,
          replaced: records.some(record => record.type === 'childList'), scrollY, pressed: window.__pressed });
        window.__roadmapJump = window.__roadmapJump.slice(-12);
      });
      observer.observe(document.querySelector('#roadmap'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    })()`);
    await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="m:0.9.1"]')`);
    await chrome.waitFor(`document.querySelector('#roadmap-list [data-key="m:0.9.1"]')?.classList.contains('roadmap-arrival')`);
    await chrome.stable('render()');
    assert.equal(await chrome.stable(`document.querySelector('#roadmap-list [data-key="m:0.9.1"]')?.classList.contains('roadmap-arrival')`), true, 'a redraw keeps the actual release-jump mark');
    const position = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const bar = document.querySelector('.top').getBoundingClientRect();
      const target = document.querySelector('#roadmap-list [data-key="m:0.9.1"]').getBoundingClientRect();
      const heading = document.querySelector('#roadmap-list [data-key="m:0.9.1"] .milestone-head h2').getBoundingClientRect();
      const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const maxScroll = documentHeight - window.innerHeight;
      return { barTop:bar.top, barBottom:bar.bottom, barHeight:bar.height, targetTop:target.top, headingTop:heading.top,
        documentHeight, viewportHeight:window.innerHeight, scrollY:window.scrollY, maxScroll, remainingScroll:maxScroll-window.scrollY };
    })())`));
    console.log('phone release jump geometry', JSON.stringify(position));
    assert.ok(position.barHeight > 56, `the phone header must wrap beyond its desktop height: ${JSON.stringify(position)}`);
    assert.ok(position.remainingScroll > 300, `the jump is not clamped near the document bottom: ${JSON.stringify(position)}`);
    assert.ok(position.headingTop >= position.barBottom, `the entire release heading sits below the wrapped header: ${JSON.stringify(position)}`);
    assert.ok(position.scrollY > 0, `the release jump scrolls the page: ${JSON.stringify(position)}`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 812, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await press(chrome, `document.querySelector('#roadmap-panel [data-roadmap-jump="m:0.9.1"]')`);
    const desktop = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const bar = document.querySelector('.top').getBoundingClientRect();
      const target = document.querySelector('#roadmap-list [data-key="m:0.9.1"]');
      const heading = target.querySelector('.milestone-head h2').getBoundingClientRect();
      return { margin:getComputedStyle(target).scrollMarginTop, barBottom:bar.bottom, headingTop:heading.top };
    })())`));
    console.log('desktop release jump geometry', JSON.stringify(desktop));
    assert.equal(desktop.margin, '72px', `desktop keeps today's scroll offset: ${JSON.stringify(desktop)}`);
    assert.ok(desktop.headingTop >= desktop.barBottom, `desktop heading stays below the top bar: ${JSON.stringify(desktop)}`);
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the release chevron lines up with its title [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the release chevron check.');
  const box = machine();
  const alpha = project(box, 'release-chevron');
  for (const title of ['Shipped work', 'Open work', 'More open work']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'shipped.html');
  accept(box, alpha, 1);
  box.run(alpha.repo, 'milestone', 'add', 'Old release', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', 'Next release with a longer name', '--reason', 'Arrange fixture release', '--items', '2,3');
  box.run(alpha.repo, 'milestone', 'ship', 'Old release', '--next', 'Next release with a longer name');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Nothing filed yet.');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-release-chevron-chrome-'));
  let chrome;
  /** Each visible release head: its chevron's centre against the centre of its title's first line of text. */
  const offsets = async () => JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#roadmap-list .milestone-head')].filter((head) => head.getClientRects().length).map((head) => {
    // A release with a shared header (0ab202b994) carries its chevron beside the header, not inside the title.
    const caret = head.querySelector('h2 > .caret') || head.querySelector(':scope > .caret'), title = head.querySelector('h2');
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const text = walker.nextNode(), range = document.createRange();
    range.selectNodeContents(text);
    const line = range.getClientRects()[0], mark = caret?.getBoundingClientRect();
    return { key: head.dataset.roadmapKey, open: head.getAttribute('aria-expanded'), svg: caret?.tagName.toLowerCase() || null, size: mark ? [Math.round(mark.width), Math.round(mark.height)] : null,
      offset: mark ? Math.round(((mark.top + mark.height / 2) - (line.top + line.height / 2)) * 10) / 10 : null };
  }))`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 3');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('[data-key=\"shipped\"] > .milestone-head')");
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      for (const pass of ['as opened', 'toggled']) {
        const heads = await offsets();
        assert.ok(heads.length >= 3, `${width} ${pass}: every release head is read: ${JSON.stringify(heads)}`);
        for (const head of heads) {
          assert.equal(head.svg, 'svg', `${width} ${pass} ${head.key}: the disclosure is the view's stroke chevron`);
          assert.ok(head.size[0] >= 15 && head.size[0] <= 17, `${width} ${pass} ${head.key}: the chevron is about 16px: ${head.size}`);
          assert.ok(Math.abs(head.offset) <= 2, `${width} ${pass} ${head.key} (${head.open}): the chevron centres on the title's first line: ${head.offset}px`);
        }
        // Flip every head, inner ones first so a folding Shipped never hides one still to press; each is measured both ways.
        for (const key of heads.map((head) => head.key).reverse()) await press(chrome, `document.querySelector('[data-roadmap-key=${JSON.stringify(key)}].milestone-head')`); // a shared-header release nests its head in .release-header
        await chrome.waitFor(`[...document.querySelectorAll('#roadmap-list .milestone-head')].filter((head) => head.getClientRects().length).length >= 3`);
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'the roadmap raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
