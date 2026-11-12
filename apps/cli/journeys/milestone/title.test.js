/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/**
 * The browser tab title is built once per refresh and written only when it changes (#3200) [N26,N38]. The page draws
 * from one client store (#6613): a tab switch reads it with no request, a live update rewrites only the parts whose
 * markup changed and keeps their scroll, and the title and badge counts have one writer.
 */
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

/** A board with one landed item and two open ones, planned over two releases. */
function titleBoard() {
  const box = machine();
  const demo = project(box, 'tab-title');
  for (const title of ['Ready to land', 'Next work', 'Later work']) box.run(demo.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The page shows the work.');
  build(box, demo, 1, 'landing.txt');
  accept(box, demo, 1);
  box.run(demo.repo, 'milestone', 'add', 'Next', '--items', '1,2', '--reason', 'the fixture plans two releases');
  box.run(demo.repo, 'milestone', 'add', 'Later', '--items', '3', '--reason', 'the fixture plans two releases');
  return { box, demo };
}

/** Count each write to a fake element's markup, and reset its scroll as a browser does when its content is replaced. */
function watchParts(page, ids) {
  const counts = {};
  for (const id of ids) {
    const part = page.element(id);
    const markup = Object.getOwnPropertyDescriptor(part, 'innerHTML');
    counts[id] = 0;
    Object.defineProperty(part, 'innerHTML', { configurable: true, get: markup.get, set(value) { markup.set.call(this, value); counts[id] += 1; this.scrollTop = 0; } });
  }
  return counts;
}

/** The Spec tab button as the chrome writer finds it, counting its writes. */
function specTabButton(page) {
  const button = { title: '', html: 'Spec', writes: 0 };
  Object.defineProperty(button, 'innerHTML', { get: () => button.html, set(value) { button.html = String(value); button.writes += 1; } });
  page.element('tabs').querySelector = (selector) => (selector === '[data-tab=spec]' ? button : null);
  return button;
}

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

test('#6613 clause 3: the title and each badge count have exactly one writer in the served page [N26]', () => {
  const page = cockpitPage('');
  assert.equal(writes(page).length, 1, 'one title write');
  assert.equal(page.match(/\$\('status-board'\)/gu).length, 1, 'one writer draws the status bar counts');
  assert.equal(page.match(/\$\('status-unread'\)/gu).length, 1, 'one writer fills the unread count');
  assert.equal(page.match(/'Spec <b>'/gu).length, 1, 'one writer sets the Spec tab count');
  assert.match(page, /function writeChrome\(\)/u, 'the chrome writer is one function');
  assert.equal(page.match(/document\.title = next|\$\('status-board'\)|\$\('status-unread'\)|'Spec <b>'/gu).length, 4);
  const chrome = page.slice(page.indexOf('function writeChrome()'));
  const body = chrome.slice(0, chrome.indexOf('\n}\n'));
  for (const write of ['document.title = next', "$('status-board')", "$('status-unread')", "'Spec <b>'"]) assert.ok(body.includes(write), write + ' happens inside writeChrome');
});

// budget: hang ceiling for native fixture setup and 24 in-process refreshes; no speed threshold.
test('clause 2: refreshing each tab three times shows the same title every time, on Cost and Roadmap included (#3200) [N26,N38]; #6613 clause 3: the badge counts hold too', { timeout: 120_000 }, async () => {
  const { box } = titleBoard();
  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run(`globalThis.titleWrites = []; { let shown = document.title; Object.defineProperty(document, 'title', {
      get: () => shown, set: (value) => { titleWrites.push(value); shown = value; } }); }`);
    const spec = specTabButton(page);
    const parts = watchParts(page, ['status-board', 'status-unread']);
    const seen = {};
    for (const tab of TABS) {
      page.run(`openTab(${JSON.stringify(tab)}); render()`);
      await page.run('refresh()');
      const before = page.run('titleWrites.length');
      const written = { ...parts, spec: spec.writes };
      const titles = [], badges = [];
      for (let round = 0; round < 3; round++) {
        await page.run('refresh()');
        titles.push(page.run('document.title'));
        badges.push([page.show('status-board'), page.show('status-unread'), page.element('status-unread').hidden, spec.innerHTML, spec.title]);
      }
      assert.deepEqual(titles, Array(3).fill(titles[0]), tab + ': the same title across three refreshes');
      assert.equal(page.run('titleWrites.length'), before, tab + ': a refresh that changes nothing writes no title');
      assert.deepEqual(badges, Array(3).fill(badges[0]), tab + ': the same badge counts across three refreshes');
      assert.deepEqual({ ...parts, spec: spec.writes }, written, tab + ': a refresh that changes nothing writes no badge');
      assert.match(spec.innerHTML, /^Spec <b>\d+<\/b>$/u, tab + ': the Spec count shows on every tab, not only on Spec');
      assert.match(page.show('status-board'), /<b>2<\/b> items/u, tab + ': the status bar counts the board on every tab');
      seen[tab] = { title: titles[0], badges: badges[0] };
    }
    assert.match(seen.roadmap.title, /^\(\d+ remaining\) tab-title · Roadmap · Pullboard$/u, 'Roadmap carries its remaining count');
    assert.equal(seen.cost.title, 'tab-title · Cost · Pullboard', 'Cost carries the Cost label');
    for (const tab of TABS.filter(tab => !['roadmap', 'cost'].includes(tab))) assert.match(seen[tab].title, /^(?:\(\d+\) )?tab-title · Pullboard$/u, tab + ' keeps the needs title');
    for (const tab of TABS) assert.deepEqual(seen[tab].badges.slice(0, 1).concat(seen[tab].badges.slice(3)), seen.dashboard.badges.slice(0, 1).concat(seen.dashboard.badges.slice(3)), tab + ': the same counts as every other tab');
  } finally {
    await view.stop();
  }
});

// budget: hang ceiling for native fixture setup, one build and a few in-process refreshes; no speed threshold.
test('#6613 clauses 1 and 2: a tab switch reads the store with no request, and a live update rewrites only the changed parts and keeps their scroll [N26]', { timeout: 120_000 }, async () => {
  const { box, demo } = titleBoard();
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const switchTo = async (tab) => { await page.click({ tab }); };
    // Visit every tab once, as a person looking round does, then settle on Items with the third item open.
    for (const tab of TABS) await switchTo(tab);
    await switchTo('items');
    await page.click({ item: '3' });
    await page.run('refresh()');
    const ids = ['chain', 'detail', 'item-list', 'needs', 'filter-menu', 'items-view-switch', 'proof-stats', 'prod-list', 'proj-list', 'status-board', 'feed', 'spec-list', 'doctrine-list', 'activity'];
    const counts = watchParts(page, ids);
    for (const id of ['item-list', 'chain', 'detail']) page.element(id).scrollTop = 240;

    // Clause 1: switching tabs asks for nothing and draws nothing a pane already shows.
    const asked = page.requests.length;
    for (const tab of [...TABS, 'items']) await switchTo(tab);
    assert.equal(page.requests.length, asked, 'tab switches send no request: ' + JSON.stringify(page.requests.slice(asked).map(request => request.path)));
    assert.deepEqual(Object.entries(counts).filter(([, n]) => n), [], 'a pane drawn from the same board is shown as it is');
    assert.equal(page.run('view.tab'), 'items');

    // A refresh that changes nothing rewrites nothing.
    await page.run('refresh()');
    assert.deepEqual(Object.entries(counts).filter(([, n]) => n), [], 'an unchanged board rewrites no part');

    // Clause 2: a live update (item 2 claimed and submitted) rewrites the parts it changes and leaves the rest.
    build(box, demo, 2, 'next.txt');
    await page.run('refresh()');
    assert.ok(counts.chain === 1, 'the list holds item 2, so it is drawn once: ' + counts.chain);
    assert.ok(counts['status-board'] === 1, 'the status bar counts item 2, so it is drawn once');
    assert.equal(counts.detail, 0, 'item 3 did not move, so its detail is not drawn again');
    assert.equal(counts['items-view-switch'], 0, 'the List and Pipeline switch did not change');
    assert.equal(counts['prod-list'], 0, 'the products did not change');
    for (const id of ['feed', 'spec-list', 'doctrine-list', 'activity']) assert.equal(counts[id], 0, id + ' is on another tab: a live update draws it when it is shown');
    for (const id of ['item-list', 'chain', 'detail']) assert.equal(page.element(id).scrollTop, 240, id + ' keeps its scroll through the update');
    assert.match(page.show('chain'), /data-item="2"/u, 'the list shows the update');
    assert.equal(page.run('view.item'), 3, 'the open item stays open');

    // After the update, switching away and back draws the stale pane once from the store, still with no request.
    const later = page.requests.length;
    for (const tab of ['spec', 'shouts', 'items', 'spec']) await switchTo(tab);
    assert.equal(page.requests.length, later, 'switches after a live update send no request: ' + JSON.stringify(page.requests.slice(later).map(request => request.path)));
    const drawn = counts['spec-list'];
    await switchTo('items');
    await switchTo('spec');
    assert.equal(counts['spec-list'], drawn, 'a pane drawn since the update is not drawn again on the next switch');
  } finally {
    await view.stop();
  }
});
