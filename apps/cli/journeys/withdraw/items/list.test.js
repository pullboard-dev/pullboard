// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks: the list filter and the items toolbar [N26]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tapTarget } from '../../../tests/fixtures/cockpit/harness.js';
import { SPEC } from '../../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { target } from '../../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { press } from '../../../tests/fixtures/cockpit/harness.js';

test('the list shows active, verified or all [N26]', async () => {
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'alpha', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'api', 'Endpoint', '--specs', 'G1', '--criterion', 'answers');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    const control = () => [...page.show('filter-menu').matchAll(/<button class="filter-option" role="menuitemradio" aria-checked="(true|false)" data-filter-choice="state:([a-z]+)"[^>]*><span class="filter-option-label">([A-Za-z ]+)<\/span><b>(\d+)<\/b><\/button>/g)].map((match) => `${match[3]} ${match[4]}${match[1] === 'true' ? ' (shown)' : ''}`);
    const rows = () => [...page.show('chain').matchAll(/data-item="(\d+)"/g)].map((match) => Number(match[1])).sort();
    assert.deepEqual(control(), ['Active 1 (shown)', 'Verified 1', 'All 2'], 'three choices, each with its count');
    assert.deepEqual(rows(), [2]);
    await page.click({ state: 'verified' });
    assert.deepEqual(rows(), [1]);
    await page.click({ state: 'all' });
    assert.deepEqual(rows(), [1, 2]);
    assert.match(page.html, /<div class="card-panel toolbar" id="items-toolbar">\s*<div class="items-view-switch" id="items-view-switch"><\/div>\s*<div class="filter-control"><button class="filter-toggle" id="filter-toggle"/, 'the view toggle and filter are together in the toolbar');
    assert.doesNotMatch(page.html, /id="lane-pick"|id="state-chips"/, 'the old second-row controls are gone');
    assert.match(page.html, /<header class="top">[^]*<div class="top-find"><input id="q" type="search"[^]*<\/header>/, 'and the search is in the top bar');
    assert.doesNotMatch(page.html, /id="lane-filter"|class="chips" id="state-chips"/, 'no lane menu and no row of chips');

    await page.click({ state: 'active' });
    await page.type('q', 'api');
    assert.deepEqual(rows(), [2], 'typing a lane finds its items');
  } finally {
    await view.stop();
  }
});

test('the items toolbar is one row: view, filter and new [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the required real-Chrome toolbar check needs Chrome');
  const box = machine();
  const longLane = 'apilonglanenameforclipping';
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, [longLane]: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'toolbar', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Active item', '--specs', 'G1');
  await box.inProcess(alpha.repo, 'add', longLane, 'Another item', '--specs', 'G1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-items-toolbar-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelectorAll('#chain .row').length === 2");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      for (const scheme of ['light', 'dark']) {
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
        await press(chrome, "document.querySelector('#filter-toggle')");
        await chrome.waitFor("!document.querySelector('#filter-menu').hidden");
        const layout = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const toolbar = document.querySelector('.toolbar'), nodes = [...toolbar.children];
          const rect = node => { const r = node.getBoundingClientRect(), edges = node.matches('.seg button') ? [...node.querySelectorAll('.seg-hit')].map(edge => edge.getBoundingClientRect()) : []; const top = Math.min(r.top, ...edges.map(edge => edge.top)), bottom = Math.max(r.bottom, ...edges.map(edge => edge.bottom)); return { top, bottom, height:bottom-top, left:r.left, right:r.right }; };
          const menu = rect(document.querySelector('#filter-menu'));
          return { children:nodes.map(node => node.id || node.className), rows:nodes.map(rect), scroll:toolbar.scrollWidth,
            client:toolbar.clientWidth, page:document.documentElement.scrollWidth, width:innerWidth,
            menu,
            buttons:[...toolbar.querySelectorAll('button')].map(node => ({ text:node.innerText, name:node.getAttribute('aria-label'), height:rect(node).height })),
            groups:[...document.querySelectorAll('#filter-menu .filter-group')].map(group => group.getAttribute('aria-label')) };
        })())`));
        assert.deepEqual(layout.children, ['items-view-switch', 'filter-control', 'new-item'], `${width}/${scheme}: exactly the three toolbar controls appear in order`);
        // One row: the controls share a centre line (the segmented options retain their 44px hitboxes within the 44px track).
        const centres = layout.rows.map(row => (row.top + row.bottom) / 2);
        assert.ok(Math.max(...centres) - Math.min(...centres) <= 2, `${width}/${scheme}: controls share one row: ${JSON.stringify(layout)}`);
        assert.ok(layout.scroll <= layout.client && layout.page <= width, `${width}/${scheme}: no horizontal toolbar or page scroll: ${JSON.stringify(layout)}`);
        assert.ok(layout.menu.left >= 0 && layout.menu.right <= width, `${width}/${scheme}: the long-lane menu stays within the viewport: ${JSON.stringify(layout.menu)}`);
        assert.deepEqual(layout.groups, ['Show', 'Lane'], `${width}/${scheme}: the open filter has both groups`);
        assert.deepEqual(layout.buttons.slice(0, 2).map(button => button.text), ['List', 'Pipeline'], `${width}/${scheme}: List and Pipeline lead the row`);
        assert.ok(layout.buttons.every(button => button.height >= tapTarget(width)), `${width}/${scheme}: toolbar buttons meet the ${tapTarget(width)}px target: ${JSON.stringify(layout.buttons)}`);
        assert.equal(layout.buttons.at(-1).name, 'New item', `${width}/${scheme}: the new action keeps its accessible name`);
        assert.equal(layout.buttons.at(-1).text, width < 900 ? 'New' : 'New item', `${width}/${scheme}: the new action uses the right visible label`);
        if (process.env.PULLBOARD_ITEMS_TOOLBAR_PROOF) {
          mkdirSync(process.env.PULLBOARD_ITEMS_TOOLBAR_PROOF, { recursive: true });
          const shot = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          writeFileSync(join(process.env.PULLBOARD_ITEMS_TOOLBAR_PROOF, `toolbar-${width}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
        }
        await press(chrome, "document.querySelector('#detail')");
        await chrome.waitFor("document.querySelector('#filter-menu').hidden");
      }
    }
    await press(chrome, "document.querySelector('#new-item')");
    await chrome.waitFor("!document.querySelector('#add-form').hidden");
    await press(chrome, "document.querySelector('#add-cancel')");
    await chrome.waitFor("document.querySelector('#add-form').hidden");
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
