/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** The browser tab title is built once per refresh and written only when it changes (#3200) [N26,N38]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { tabTitle } from '../../../view/index.js';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../index.js';
import {
  machine,
  project,
  build,
  accept,
  startView,
  openPage,
} from '../../tests/fixtures/cockpit/harness.js';

const TABS = ['dashboard', 'items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap', 'cost'];
const writes = source => source.match(/document\.title\s*=(?!=)/gu) ?? [];

test('clause 1: one function builds the title from the tab and board: remaining on Roadmap, Cost label on Cost, needs elsewhere (#3200) [N26,N38]', () => {
  const place = { shown: true, name: 'alpha', needs: 2, remaining: 3, cost: true };
  assert.equal(tabTitle({ ...place, tab: 'roadmap' }), '(3 remaining) alpha · Roadmap · Pullboard');
  assert.equal(tabTitle({ ...place, tab: 'roadmap', remaining: null }), 'alpha · Roadmap · Pullboard');
  assert.equal(tabTitle({ ...place, tab: 'cost' }), 'alpha · Cost · Pullboard');
  assert.equal(tabTitle({ ...place, tab: 'cost', cost: false }), '(2) alpha · Pullboard', 'a page without private Cost keeps the needs title');
  for (const tab of ['dashboard', 'items', 'activity']) assert.equal(tabTitle({ ...place, tab }), '(2) alpha · Pullboard');
  assert.equal(tabTitle({ ...place, tab: 'items', needs: 0 }), 'alpha · Pullboard');
  assert.equal(tabTitle({ ...place, tab: 'roadmap', group: true }), '(2) alpha · Pullboard', 'a project group keeps the needs title');
  assert.equal(tabTitle({ shown: false, tab: 'roadmap' }), 'Pullboard');
});

test('clause 1: cockpit-sidebar.js and page-render.js no longer set the title separately; the page writes it once, only when it differs (#3200) [N26,N38]', () => {
  assert.equal(writes(readFileSync(new URL('../../../view/src/io/page/render.js', import.meta.url), 'utf8')).length, 0, 'page-render.js sets no title');
  const page = cockpitPage('');
  assert.equal(writes(page).length, 1, 'the served page has one title write');
  assert.match(page, /if \(document\.title !== next\) document\.title = next;/u, 'the write happens only when the built title differs');
  assert.match(page, /const next = tabTitle\(/u, 'the written value comes from tabTitle');
});

// budget: hang ceiling for native fixture setup and 24 in-process refreshes; no speed threshold.
test('clause 2: refreshing each tab three times shows the same title every time, on Cost and Roadmap included (#3200) [N26,N38]', { timeout: 120_000 }, async () => {
  const box = machine();
  const demo = project(box, 'tab-title');
  for (const title of ['Ready to land', 'Next work', 'Later work']) box.run(demo.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The page shows the work.');
  build(box, demo, 1, 'landing.txt');
  accept(box, demo, 1);
  box.run(demo.repo, 'milestone', 'add', 'Next', '--items', '1,2', '--reason', 'the fixture plans two releases');
  box.run(demo.repo, 'milestone', 'add', 'Later', '--items', '3', '--reason', 'the fixture plans two releases');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run(`globalThis.titleWrites = []; { let shown = document.title; Object.defineProperty(document, 'title', {
      get: () => shown, set: (value) => { titleWrites.push(value); shown = value; } }); }`);
    const seen = {};
    for (const tab of TABS) {
      page.run(`openTab(${JSON.stringify(tab)}); render()`);
      await page.run('refresh()');
      const before = page.run('titleWrites.length');
      const titles = [];
      for (let round = 0; round < 3; round++) {
        await page.run('refresh()');
        titles.push(page.run('document.title'));
      }
      assert.deepEqual(titles, Array(3).fill(titles[0]), tab + ': the same title across three refreshes');
      assert.equal(page.run('titleWrites.length'), before, tab + ': a refresh that changes nothing writes no title');
      seen[tab] = titles[0];
    }
    assert.match(seen.roadmap, /^\(\d+ remaining\) tab-title · Roadmap · Pullboard$/u, 'Roadmap carries its remaining count');
    assert.equal(seen.cost, 'tab-title · Cost · Pullboard', 'Cost carries the Cost label');
    for (const tab of TABS.filter(tab => !['roadmap', 'cost'].includes(tab))) assert.match(seen[tab], /^(?:\(\d+\) )?tab-title · Pullboard$/u, tab + ' keeps the needs title');
  } finally {
    await view.stop();
  }
});
