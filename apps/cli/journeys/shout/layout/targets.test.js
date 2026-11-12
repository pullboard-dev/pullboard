// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/cost.css apps/view/src/io/doctrine.css apps/view/src/io/item/panel.css apps/view/src/io/item/rows.css */
/** @pullboard-test-gui */
/** Cockpit layout checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  openShoutConversation,
  SPEC,
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../../tests/fixtures/cockpit/harness.js';



test('targets are 44px for touch and compact under a mouse [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for target size checks.');
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'targets', SPEC, { lanes });
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'api', 'Endpoint', '--specs', 'G1', '--criterion', 'answers');
  box.run(alpha.web, 'claim', '1');
  box.run(alpha.web, 'shout', 'all', 'Greeting is under way; see #2 after.');
  // A shout that is only a reference: nothing shares its line, so it is a target like any button.
  box.run(alpha.web, 'shout', 'all', '#2');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-targets-chrome-'));
  let chrome;
  /** Every visible enabled action with its height, which references sit in running text, and the named compact ones. */
  const audit = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const visible = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return !e.disabled && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !e.closest('[hidden]'); };
    const targetHeight = e => { const box = e.getBoundingClientRect(), edges = e.matches('.seg button') ? [...e.querySelectorAll('.seg-hit')].map(edge => edge.getBoundingClientRect()) : []; return Math.max(box.bottom, ...edges.map(edge => edge.bottom)) - Math.min(box.top, ...edges.map(edge => edge.top)); };
    const height = (s) => { const e = document.querySelector(s); return e && visible(e) ? Math.round(targetHeight(e)) : null; };
    const selector = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[data-tab],[data-go],[data-item],[data-state],[data-row],[data-new]';
    // A reference inside running text is exempt from 44px, as WCAG 2.5.8 exempts inline targets: only the elements named
    // here, and only where text that is not another control's shares their line in the same block.
    const named = (e) => e.matches('.feed button.ref, .feed a.ref[data-go], .shout button.ref, .shout a.ref[data-go], .shout .band a, .detail button.ref, .detail a.ref[data-go], .t button.ref, .t a.ref[data-go]') || !!e.closest('#chain .meta .gate, #detail .kv dd.waits-on');
    const inLine = (e) => {
      let block = e.parentElement;
      while (block.parentElement && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement;
      const r = e.getBoundingClientRect(), walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        const owner = node.parentElement.closest(selector);
        if (e.contains(node) || !node.textContent.trim() || (owner && owner !== block && block.contains(owner))) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if ([...range.getClientRects()].some((line) => line.width > 0 && line.top < r.bottom && line.bottom > r.top)) return true;
      }
      return false;
    };
    const controls = [...new Set(document.querySelectorAll(selector))].filter(visible).map((e) => ({ text: (e.innerText || e.getAttribute('aria-label') || e.id || e.className).trim().slice(0, 40), height: targetHeight(e),
      inline: named(e) && inLine(e), named: named(e), inLine: inLine(e) }));
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      tap: getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(), coarse: matchMedia('(pointer: coarse)').matches,
      short: controls.filter((c) => c.height < 44 && !c.inline), count: controls.length,
      exempt: controls.filter((c) => c.named).map((c) => ({ text: c.text, height: Math.round(c.height), inLine: c.inLine })), standalone: inLine(document.querySelector('#new-item')),
      toolbar: { views: [...document.querySelectorAll('.items-view-switch button')].filter(visible).map((b) => Math.round(targetHeight(b))), filter: height('#filter-toggle'), go: height('#new-item') },
      composer: { text: height('#shout-text'), send: height('#shout-send') }, status: [...document.querySelectorAll('.status [data-status]')].filter(visible).map((b) => Math.round(b.getBoundingClientRect().height)),
    };
  })())`));
  const tab = async (name) => { await chrome.click(`document.querySelector('[data-tab=${name}]')`); await chrome.waitFor(`!document.querySelector('[data-pane=${name}]').hidden`); };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 2 && data.project.shouts.length >= 2");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        await tab('items');
        const items = await audit();
        await tab('shouts');
        await openShoutConversation(chrome, 'item:2');
        const shouts = await audit();
        for (const r of [items, shouts]) assert.ok(r.page.scroll <= r.page.width, `${at}: no sideways scroll`);
        if (width === 375) {
          // In a narrow window every action is a 44px target, as a finger needs.
          assert.equal(items.tap, '44px', `${at}: the target is 44px`);
          for (const [name, r] of [['Items', items], ['Shouts', shouts]]) assert.deepEqual(r.short, [], `${at} ${name}: every action at least 44px high: ${JSON.stringify(r.short)}`);
          // In native ascending message order, the named references retain their sizes: #2 alone is a 44px target; only the #2 inside the shout's sentence, in a
          // line of its words, is exempt. The same check refuses a standalone button.
          assert.deepEqual([items.exempt, shouts.exempt.map((e) => [e.text, e.inLine, e.height >= 44])], [[], [['#2', true, false], ['#2', false, true]]], `${at}: #2 alone is a target, #2 in its sentence the only exemption: ${JSON.stringify([items.exempt, shouts.exempt])}`);
          assert.equal(items.standalone, false, `${at}: a standalone button is never inside a line of text`);
        } else {
          // Under a mouse on a wide screen controls size to their words: the Items toolbar at 32px, the composer one line.
          assert.equal(items.tap, '32px', `${at}: the target is 32px under a mouse`);
          assert.ok(items.toolbar.views.length === 2 && [...items.toolbar.views, items.toolbar.filter, items.toolbar.go].every((h) => Math.abs(h - 32) <= 1), `${at}: the Items toolbar's controls are 32px: ${JSON.stringify(items.toolbar)}`);
          assert.ok(shouts.composer.text <= 34 && Math.abs(shouts.composer.send - 32) <= 1, `${at}: the composer is one line of text: ${JSON.stringify(shouts.composer)}`);
          assert.ok(items.status.length > 0 && items.status.every((h) => h <= 30), `${at}: the status bar keeps its thin strip, no exception needed: ${JSON.stringify(items.status)}`);
          assert.ok(items.short.length > 0, `${at}: there is no blanket 44px minimum under a mouse`);
        }
      }
    }

    // Under touch on the same wide screen, every action is a 44px target again, the status bar's parts included.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await chrome.waitFor("innerWidth === 1280 && matchMedia('(pointer: coarse)').matches");
    await tab('items');
    const touchItems = await audit();
    await tab('shouts');
    await openShoutConversation(chrome, 'item:2');
    const touchShouts = await audit();
    assert.equal(touchItems.tap, '44px', 'under touch the target is 44px');
    for (const [name, r] of [['Items', touchItems], ['Shouts', touchShouts]]) assert.deepEqual(r.short, [], `touch ${name}: every action at least 44px high: ${JSON.stringify(r.short)}`);
    assert.ok(touchItems.status.every((h) => h >= 44), `touch: the status bar's parts are 44px: ${JSON.stringify(touchItems.status)}`);
    // In native ascending message order, the named references retain their sizes: #2 alone is a 44px target; only the #2 inside the shout's sentence, in a
    // line of its words, is exempt. The same check refuses a standalone button.
    assert.deepEqual([touchItems.exempt, touchShouts.exempt.map((e) => [e.text, e.inLine, e.height >= 44])], [[], [['#2', true, false], ['#2', false, true]]], `touch: #2 alone is a target, #2 in its sentence the only exemption: ${JSON.stringify([touchItems.exempt, touchShouts.exempt])}`);
    assert.equal(touchItems.standalone, false, `touch: a standalone button is never inside a line of text`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
