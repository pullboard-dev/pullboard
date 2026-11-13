// pullboard: browser
/** @pullboard-test-gui */
/** #6614 clause 2: every tab, filter and search has its own address; back, forward and reload land on that exact view [N38,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  machine,
  press,
  travel,
  settled,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  SCRIPT,
  openAddress,
  history,
  addressBoard,
  withBrowser,
} from '../../../tests/fixtures/cockpit/addresses.js';

test('clause 2: every tab, filter and search has its own address, and back, forward and reload land on that exact view [N38,N26]', { timeout: 180_000 }, async () => { // budget: hang-only ceiling for real clicks, stack traversal and reloads.
  const box = machine();
  addressBoard(box, 'filter-alpha');
  await withBrowser(box, async (chrome, server) => {
    /** The exact view: the address with its query, the tab, the Items filter, the search words, Spec's rows. */
    const exact = async () => JSON.parse(await chrome.stable(`JSON.stringify({ address: location.pathname + location.search.replace(/[?&]k=[^&]*/u, '').replace(/^&/u, '?'), tab: view.tab,
      state: view.tab === 'items' ? view.state : null, words: document.querySelector('#q').value, rows: view.tab === 'spec' ? view.rows.spec : null, crumb: document.querySelector('#crumb-page').textContent,
      panes: [...document.querySelectorAll('[data-pane]')].filter(node => !node.hidden).map(node => node.dataset.pane) })`));
    await openAddress(chrome, server, '/items');
    const places = [await exact()];
    /** Press, wait for the page, and keep the place it lands on, with exactly one new history entry. */
    const step = async (selector, check) => {
      const before = await history(chrome);
      await press(chrome, selector);
      await settled(chrome, `${SCRIPT} && (${check})`);
      assert.deepEqual(await history(chrome), { currentIndex: before.currentIndex + 1, length: before.length + 1 }, `${selector}: one entry per change`);
      places.push(await exact());
    };
    // Every page in the strip, the menus' pages included, at its own address.
    for (const tab of ['progress', 'shouts', 'roadmap', 'spec', 'doctrine', 'dashboard', 'activity', 'items']) await step(`document.querySelector('[data-tab="${tab}"]')`, `location.pathname === '/${tab}'`);
    assert.deepEqual(places.slice(1).map(place => [place.address, place.crumb, place.panes.join()]), [
      ['/progress', 'Progress', 'progress'], ['/shouts', 'Shouts', 'shouts'], ['/roadmap', 'Roadmap', 'roadmap'], ['/spec', 'Spec', 'spec'],
      ['/doctrine', 'Doctrine', 'doctrine'], ['/dashboard', 'Dashboard', 'dashboard'], ['/activity', 'Activity', 'activity'], ['/items', 'Items', 'items'],
    ]);
    // A filter and an open row.
    await press(chrome, "document.querySelector('#filter-toggle')");
    await step("document.querySelector('#filter-menu [data-filter-choice=\"state:all\"]')", "location.search.includes('state=all')");
    await step("document.querySelector('#chain .row[data-item=\"2\"]')", "location.pathname === '/items/2'");
    assert.deepEqual([places.at(-2).address, places.at(-2).state, places.at(-1).address], ['/items?state=all', 'all', '/items/2?state=all']);
    // A search: typing keeps one entry, its words in the address.
    await press(chrome, "document.querySelector('#q')");
    await chrome.send('Input.insertText', { text: 'second' });
    await settled(chrome, "location.search.includes('q=second')");
    places[places.length - 1] = await exact();
    // Leaving the field puts the results away, as a person's next press does.
    await press(chrome, "document.querySelector('#crumb-page')");
    await settled(chrome, "document.querySelector('#find-results').hidden");
    assert.deepEqual([places.at(-1).address, places.at(-1).words, places.at(-1).state], ['/items/2?q=second', 'second', 'all']);
    // Spec's row filter.
    await step("document.querySelector('[data-tab=\"spec\"]')", "location.pathname === '/spec'");
    await step("document.querySelector('[data-rows=\"spec:all\"]')", "location.search.includes('rows=all')");
    assert.deepEqual([places.at(-1).address, places.at(-1).rows], ['/spec?q=second&rows=all', 'all']);

    // Back through every place, then forward again: each lands on its exact view.
    for (let index = places.length - 2; index >= 0; index -= 1) {
      await travel(chrome, -1);
      await settled(chrome, SCRIPT);
      assert.deepEqual(await exact(), places[index], `back to ${places[index].address}`);
    }
    for (let index = 1; index < places.length; index += 1) {
      await travel(chrome, 1);
      await settled(chrome, SCRIPT);
      assert.deepEqual(await exact(), places[index], `forward to ${places[index].address}`);
    }
    // Reload on each filtered or searched place: the same view.
    for (const place of places.filter(entry => entry.address.includes('?'))) {
      // openAddress sets the session's own query, so this place's query joins it here.
      const target = new URL(place.address, server.link);
      for (const [key, value] of server.link.searchParams) target.searchParams.set(key, value);
      await chrome.send('Page.navigate', { url: target.href });
      await settled(chrome, SCRIPT);
      const before = await chrome.stable('performance.timeOrigin');
      await chrome.send('Page.reload');
      await settled(chrome, `performance.timeOrigin !== ${before} && ${SCRIPT}`);
      assert.deepEqual(await exact(), place, `reload keeps ${place.address}`);
    }
  });
});
