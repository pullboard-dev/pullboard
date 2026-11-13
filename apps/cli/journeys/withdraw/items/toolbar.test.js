// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (toolbar menu), using the shared real-board fixtures [N26]. */

import assert from 'node:assert/strict';
import {
} from 'node:fs';
import {
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  machine,
  project,
  build,
  startView,
  element,
  openPage,
  accept,
  itemRow,
} from '../../../tests/fixtures/cockpit/harness.js';


test('shout ids, search and narrow windows reach the item [N26]', async () => {
  const box = machine();
  const p = project(box, 'desk');
  await box.inProcess(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(p.repo, 'add', 'web', 'Farewell banner', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, p, 2, 'farewell.html');
  accept(box, p, 2);
  // Item 39 exists, so an escaped apostrophe (&#39;) read as an id would turn into a link.
  for (let id = 3; id <= 39; id += 1) await box.inProcess(p.repo, 'add', 'web', `Filler ${id}`, '--specs', 'G1', '--criterion', 'fills', '--not-duplicate-of', '1 a distinct fixture row');
  await box.inProcess(p.repo, 'add', 'web', 'Retired widget', '--specs', 'G1', '--criterion', 'retires');
  await box.inProcess(p.repo, 'withdraw', '40', 'nobody needs the widget');
  await box.inProcess(p.web, 'shout', 'all', "#1 is next; #2 shipped (#99 is not an item) and it's done");
  await box.inProcess(p.web, 'shout', 'all', "#7, see#7 and #7#8: it's 5 o'clock");
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    assert.equal(page.run('view.state'), 'active');
    assert.doesNotMatch(page.show('chain'), /Farewell banner/, 'Active hides the verified item');
    await page.type('q', 'farewell');
    assert.match(page.show('chain'), /Farewell banner/, 'a search finds the verified item');
    await page.type('q', '');
    assert.equal(page.run('view.state'), 'active', 'clearing the search brings the chip back');
    assert.doesNotMatch(page.show('chain'), /Farewell banner/);

    // Type, click Active with the query still there, then edit the query to the verified title.
    await page.type('q', 'filler');
    assert.equal(page.run('view.state'), 'all');
    await page.click({ state: 'active' });
    assert.equal(page.run('view.state'), 'active', 'a chip clicked mid-search narrows the list');
    await page.type('q', 'farewell banner');
    assert.equal(page.run('view.state'), 'all', 'typing again searches every state');
    assert.match(page.show('chain'), /Farewell banner/, 'and finds the verified item');
    await page.type('q', '');
    assert.equal(page.run('view.state'), 'active', 'emptying the box brings back the chip from before the search');
    assert.doesNotMatch(page.show('chain'), /Retired widget/, 'browsing leaves withdrawn items out');
    await page.type('q', 'retired widget');
    const found = itemRow(page.show('chain'), 40);
    assert.match(found, /Retired widget/, 'a search finds the withdrawn item too');
    assert.match(found, /<b class="stage-word">Ready<\/b>/);
    assert.match(found, /<span class="stage-mark no"[^>]*>Withdrawn<\/span>/);
    await page.type('q', '');

    await page.click({ tab: 'shouts' });
    const feed = ['item:1', 'item:7'].map(key => {
      page.run(`view.shoutThread = ${JSON.stringify(key)}; render();`);
      return page.show('feed');
    }).join('');
    assert.ok(feed.includes(`<a class="ref" href="/items/1" data-go="item:1" title="Greeting">#1</a> is next;`), feed);
    assert.ok(feed.includes(`<a class="ref" href="/items/2" data-go="item:2" title="Farewell banner">#2</a> shipped`));
    assert.ok(feed.includes(`(<a class="ref" href="/items/99" data-go="item:99">#99</a> is not an item) and it&#39;s done`), 'an unknown item still has its address, and the apostrophe stays intact');
    const ref = (id, title) => `<a class="ref" href="/items/${id}" data-go="item:${id}" title="${title}">#${id}</a>`;
    assert.ok(feed.includes(`${ref(7, 'Filler 7')}, see${ref(7, 'Filler 7')} and ${ref(7, 'Filler 7')}${ref(8, 'Filler 8')}: it&#39;s 5 o&#39;clock`), 'every #id links, whatever stands next to it');
    assert.equal(feed.match(/class="ref"/g).length, 7);
    await page.click({ go: 'item:2', classes: 'ref' });
    assert.equal(page.run('view.tab'), 'items', 'the link opens the Items tab');
    assert.match(page.show('detail'), /<h2><span class="id">#2<\/span>Farewell banner<\/h2>/, 'on that item');
    assert.equal(page.element('detail').scrolled, 0, 'side by side, the detail is already in view');

    const narrow = await openPage(view, { width: 600 });
    await narrow.click({ tab: 'items' });
    await narrow.click({ item: '1', classes: 'row' });
    assert.match(narrow.show('detail'), /Greeting/);
    assert.equal(narrow.element('detail').scrolled, 1, 'under 900px, picking an item brings its detail into view');
    await narrow.click({ tab: 'shouts' });
    await narrow.click({ go: 'item:2', classes: 'ref' });
    assert.equal(narrow.element('detail').scrolled, 2, 'and so does a link to one');
  } finally {
    await view.stop();
  }
});
