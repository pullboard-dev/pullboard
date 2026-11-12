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
import { sendBackWithClause } from './send-back.js';
import {
  SPEC,
  machine,
  project,
  build,
  startView,
  element,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  tabBar,
} from '../../../tests/fixtures/cockpit/harness.js';


test('the view never scrolls sideways at 320px [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the 320px check.');

  const box = machine();
  const demo = project(box, 'narrow');
  box.run(demo.repo, 'add', 'web', 'A title long enough to need every bit of a narrow phone row, and then some more words', '--specs', 'G1', '--criterion', 'fits');
  box.run(demo.repo, 'add', 'web', 'Built, then sent back', '--specs', 'G1', '--criterion', 'back');
  build(box, demo, 2, 'two.txt');
  sendBackWithClause(box, demo, 2, 'It misses the edge the criterion names, a reason long enough to wrap on a phone.', 'back');
  const sha = box.git(demo.repo, 'rev-parse', 'HEAD').trim();
  box.run(demo.repo, 'shout', 'web', `Run \`pullboard next --verify\` and read SPEC.md:1-2@${sha} before you take #1.`);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-sideways-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    // A fresh board opens on the first-run Dashboard (0de17112c6); set it aside so the tabs under test render.
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await chrome.click("document.querySelector('[data-tab=\"items\"]')");
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 2');
    // This machine's fonts first, then a wide one (Verdana here, DejaVu Sans on Linux) at 320 and at 305,
    // the room a 320px screen leaves beside a classic 15px scrollbar: Linux CI measured 324px of tabs there.
    for (const [width, font] of [[320, ''], [320, 'Verdana, "DejaVu Sans", sans-serif'], [305, 'Verdana, "DejaVu Sans", sans-serif']]) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await chrome.stable(`document.documentElement.style.setProperty('--sans', ${JSON.stringify(font || 'system-ui, sans-serif')})`);
    await chrome.waitFor(`innerWidth === ${width}`);
    for (const tab of ['dashboard', 'items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap']) {
      await chrome.click(`document.querySelector('[data-tab="${tab}"]')`);
      await chrome.waitFor(`!document.querySelector('[data-pane="${tab}"]').hidden`);
      const seen = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const edge = document.documentElement.clientWidth;
        // Name each element that runs past the edge with nothing above it to clip or scroll it.
        const clipped = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (!['visible', ''].includes(getComputedStyle(p).overflowX)) return true; return false; };
        const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
        const past = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > edge + 0.5 && !clipped(e); })
          .map((e) => name(e) + ' right ' + Math.round(e.getBoundingClientRect().right) + ': ' + (e.textContent || '').trim().slice(0, 40));
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: edge, past: past.slice(0, 8), more: Math.max(0, past.length - 8) };
      })())`));
      assert.ok(seen.scrollWidth <= seen.clientWidth, `${width}${font ? ' in a wide font' : ''}, ${tab}: the page scrolls sideways, ${seen.scrollWidth} wide in ${seen.clientWidth}; past the edge: ${seen.past.join(' | ')}${seen.more ? ` (+${seen.more} more)` : ''}`);
    }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('phone tab labels keep their two pixel inset under real wide fonts [N26]', { timeout: 120_000 }, async t => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome for the tab label geometry proof.');
  const box = machine();
  project(box, 'tab-inset');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-tab-inset-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project && document.querySelectorAll("#tabs .tab").length === 8');
    for (const [width, font] of [[375, 'system-ui, sans-serif'], [375, 'Verdana, "DejaVu Sans", sans-serif'],
      [320, 'Verdana, "DejaVu Sans", sans-serif'], [305, 'Verdana, "DejaVu Sans", sans-serif'], [1280, 'system-ui, sans-serif']]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.stable(`document.documentElement.style.setProperty('--sans', ${JSON.stringify(font)})`);
      await chrome.waitFor(`innerWidth === ${width}`);
      const bar = await tabBar(chrome);
      for (const layout of bar.layouts) {
        const where = `${width}/${font}/${layout.on}`;
        assert.equal(layout.tabs.length, 8, where + ': Dashboard and all retained complete labels remain');
        for (const tab of layout.tabs) assert.ok(tab.labelLeft >= tab.left + 2 && tab.labelRight <= tab.right - 2,
          `${where}: ${tab.tab} retains the original two-pixel inset: ${JSON.stringify(tab)}`);
        assert.equal(new Set(layout.tabs.map(tab => Math.round(tab.top))).size, width < 480 ? 2 : 1, where + ': the phone has two rows and desktop one');
        layout.tabs.forEach((tab, index) => { if (index) assert.ok(tab.top >= layout.tabs[index - 1].bottom - 0.5 || tab.left >= layout.tabs[index - 1].right - 0.5, where + ': tabs never overlap'); });
        assert.ok(layout.tabs[0].left >= layout.bar[0] - 0.5 && layout.tabs.at(-1).right <= layout.bar[1] + 0.5
          && layout.bar[1] <= bar.client, where + ': the whole tab bar fits the actual content width');
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'the real page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
