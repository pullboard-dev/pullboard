// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (toolbar menu), using the shared real-board fixtures [N26]. */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  SPEC,
  machine,
  project,
  build,
  startView,
  element,
  openPage,
  accept,
  itemRow,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';

test('the filter menu sets show and lane [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the required real-Chrome filter check needs Chrome');
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'filter', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Active item', '--specs', 'G1');
  await box.inProcess(alpha.repo, 'add', 'api', 'Verified item', '--specs', 'G1');
  const api = join(box.dir, 'filter-api');
  const apiBranch = 'api/filter';
  box.git(alpha.repo, 'worktree', 'add', '-q', api, '-b', apiBranch);
  await box.inProcess(api, 'join', 'api');
  await box.inProcess(api, 'claim', '2');
  mkdirSync(join(api, 'api'), { recursive: true });
  writeFileSync(join(api, 'api', 'verified.html'), 'verified.html\n');
  box.git(api, 'add', '-A');
  box.git(api, 'commit', '-q', '-m', 'feat(api): verified [G1]');
  await box.inProcess(api, 'submit', '2');
  box.git(alpha.repo, 'switch', '-q', '--detach', apiBranch);
  await box.inProcess(alpha.repo, 'verify', '2', 'accept', '--note', 'the page shows it', '--as', 'coordinator');
  box.git(alpha.repo, 'switch', '-q', 'main');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-items-filter-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelectorAll('#chain .row').length === 1");
    assert.equal(await chrome.stable("document.querySelector('#chain .row').dataset.item"), '1');
    await press(chrome, "document.querySelector('#filter-toggle')");
    await chrome.waitFor("!document.querySelector('#filter-menu').hidden");
    assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#filter-menu .filter-option[data-filter-kind=state]')].map(option => option.querySelector('.filter-option-label').textContent + ' ' + option.querySelector('b').textContent))")), ['Active 1', 'Verified 1', 'All 2'], 'Show choices name their counts');
    await press(chrome, "document.querySelector('#filter-menu [data-state=verified]')");
    await chrome.waitFor("view.state === 'verified' && document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("document.querySelector('#chain .row').dataset.item"), '2', 'choosing Verified updates the list at once');
    assert.equal(await chrome.stable("document.querySelector('#filter-toggle').textContent"), 'Filter: Verified');
    await press(chrome, "document.querySelector('#filter-toggle')");
    assert.equal(await chrome.stable("document.querySelector('#filter-menu .filter-option[data-filter-kind=lane][data-filter-value=api]').getAttribute('aria-label')"), 'api · 1');
    await press(chrome, "document.querySelector('#filter-menu .filter-option[data-filter-kind=lane][data-filter-value=api]')");
    await chrome.waitFor("view.lane === 'api' && document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("document.querySelector('#filter-toggle').textContent"), 'Filter: Verified · api', 'mouse can choose a lane');
    await press(chrome, "document.querySelector('#filter-toggle')");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    for (let step = 0; step < 1; step += 1) {
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    }
    await chrome.waitFor("document.activeElement.dataset.filterChoice === 'state:verified'");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    await chrome.waitFor("view.state === 'verified' && document.querySelector('#filter-menu').hidden");
    await press(chrome, "document.querySelector('#filter-toggle')");
    for (let step = 0; step < 5; step += 1) {
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    }
    await chrome.waitFor("document.activeElement.dataset.filterChoice === 'lane:api'");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    await chrome.waitFor("view.lane === 'api' && document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("document.querySelector('#chain .row').dataset.item"), '2', 'choosing a lane from the keyboard applies it immediately');
    assert.equal(await chrome.stable("document.querySelector('#filter-toggle').textContent"), 'Filter: Verified · api');
    await press(chrome, "document.querySelector('#filter-toggle')");
    assert.equal(await chrome.stable("document.querySelector('#filter-menu [data-filter-kind=state][data-filter-value=verified]').getAttribute('aria-checked')"), 'true', 'the selected Show option is marked');
    assert.equal(await chrome.stable("document.querySelector('#filter-menu [data-filter-value=api]')?.getAttribute('aria-checked')"), 'true', 'the selected Lane option is marked');
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await chrome.waitFor("document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("view.state + ':' + view.lane + ':' + document.querySelector('#filter-toggle').textContent"), 'verified:api:Filter: Verified · api', 'Escape closes without changing either choice');
    await press(chrome, "document.querySelector('#filter-toggle')");
    await press(chrome, "document.querySelector('[data-items-view=pipeline]')");
    await chrome.waitFor("view.itemsView === 'pipeline'");
    await press(chrome, "document.querySelector('#filter-toggle')");
    assert.equal(await chrome.stable("document.querySelectorAll('#filter-menu .filter-group').length"), 1, 'Pipeline omits Show');
    assert.equal(await chrome.stable("document.querySelector('#filter-menu .filter-group').getAttribute('aria-label')"), 'Lane');
    await press(chrome, "document.querySelector('#filter-menu .filter-option[data-filter-kind=lane][data-filter-value=web]')");
    await chrome.waitFor("view.lane === 'web' && document.querySelector('#filter-menu').hidden");
    assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#pipeline .pipeline-item')].map(item => item.dataset.item))")), ['1'], 'the Lane choice still filters Pipeline');
    await press(chrome, "document.querySelector('[data-items-view=list]')");
    await chrome.waitFor("view.itemsView === 'list'");
    await press(chrome, "document.querySelector('#filter-toggle')");
    await press(chrome, "document.querySelector('#detail')");
    await chrome.waitFor("document.querySelector('#filter-menu').hidden");
    assert.equal(await chrome.stable("view.state + ':' + view.lane"), 'verified:web', 'an outside click closes without changing either choice');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('shout ids, search and narrow windows reach the item [N26]', async () => {
  const box = machine();
  const p = project(box, 'desk');
  await box.inProcess(p.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(p.repo, 'add', 'web', 'Farewell banner', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, p, 2, 'farewell.html');
  accept(box, p, 2);
  // Item 39 exists, so an escaped apostrophe (&#39;) read as an id would turn into a link.
  for (let id = 3; id <= 39; id += 1) await box.inProcess(p.repo, 'add', 'web', `Filler ${id}`, '--specs', 'G1', '--criterion', 'fills');
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
    assert.match(page.show('filter-menu'), /aria-checked="true" data-filter-choice="state:all"/, 'and marks the all-state choice');
    assert.match(page.show('filter-menu'), /<span class="filter-option-label">Verified<\/span><b>1<\/b>/);
    assert.match(page.show('filter-menu'), /<span class="filter-option-label">Active<\/span><b>0<\/b>/, 'the menu counts the matches');
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
    assert.match(page.show('filter-menu'), /<span class="filter-option-label">All<\/span><b>1<\/b>/);
    assert.match(page.show('filter-menu'), /<span class="filter-option-label">Active<\/span><b>0<\/b>/, 'a withdrawn item is not active');
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
