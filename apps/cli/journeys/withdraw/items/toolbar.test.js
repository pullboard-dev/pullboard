// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (toolbar), using the shared real-board fixtures [N26]. */
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
  earlier,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';

/** The items toolbar at 375 behind CI's classic scrollbar with every label widened by a letter-spacing in em, so each
 *  widens by the same share of its face on every runner, whatever fonts the runner has (#445). With forcedFonts the
 *  toolbar also draws in a wide face where the machine has one; without, each label keeps its own face, which shows
 *  the widening never rested on the face. */
const wideFontToolbar = (forcedFonts) => async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the wide-font toolbar check needs Chrome');
  const box = machine();
  const longLane = 'apilonglanenameforclipping';
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, [longLane]: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, forcedFonts ? 'wide-fonts' : 'wide-spacing', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Active item', '--specs', 'G1');
  await box.inProcess(alpha.repo, 'add', longLane, 'Another item', '--specs', 'G1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-items-wide-fonts-chrome-'));
  let chrome;
  /** The toolbar's visible labels by their text's own width, measured from the glyphs, not the boxes, and the face each draws in. */
  const labels = async () => JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('.items-view-switch button, #filter-label, #new-item span')]
    .filter((e) => e.getClientRects().length).map((e) => { const r = document.createRange(); r.selectNodeContents(e); return [e.id || e.textContent.trim(), r.getBoundingClientRect().width, getComputedStyle(e).fontFamily]; }))`));
  const widths = (list) => JSON.stringify(list.map(([name, width]) => [name, Math.round(width * 100) / 100]));
  /** Sideways scroll of the toolbar and the page, and every box in the toolbar or its menu that reaches past the toolbar's inside edge. */
  const fit = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const bar = document.querySelector('.toolbar'), s = getComputedStyle(bar), r = bar.getBoundingClientRect();
    const left = r.left + parseFloat(s.borderLeftWidth), right = r.right - parseFloat(s.borderRightWidth);
    const name = (e) => e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : e.tagName.toLowerCase();
    const past = [...bar.querySelectorAll('*')].filter((e) => e.getClientRects().length).map((e) => [name(e), e.getBoundingClientRect()])
      .filter(([, b]) => b.left < left - 0.5 || b.right > right + 0.5).map(([n, b]) => [n, Math.round(b.left), Math.round(b.right)]);
    return { toolbar: [bar.scrollWidth, bar.clientWidth], page: [Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), innerWidth], inside: [Math.round(left), Math.round(right)], past };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelectorAll('#chain .row').length === 2");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    // CI's runners draw a classic 15px scrollbar, which the window's width counts and the page cannot use: that is
    // what put the open menu past the toolbar on every job (#442). Draw one here too.
    await chrome.stable("(() => { const sheet = document.styleSheets[0]; sheet.insertRule('html { overflow-y: scroll; }', 0); sheet.insertRule('::-webkit-scrollbar { width: 15px; }', 0); return true; })()");
    await chrome.waitFor('document.documentElement.clientWidth === 360');
    const before = await labels();
    // A letter-spacing in em on the toolbar and its menu adds the same share of each face to every letter, so the
    // widening does not hang on which fonts this machine has. On Linux CI the forced face fell back to the runner's
    // own and "New" widened only 6% (#445). The forced face, where a machine has it, widens further.
    const face = forcedFonts ? 'font-family: Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif !important; ' : '';
    await chrome.stable(`(() => { const sheet = document.styleSheets[0]; sheet.insertRule('.toolbar, .toolbar *, .filter-menu, .filter-menu * { ${face}letter-spacing: .12em !important; }', sheet.cssRules.length); return true; })()`);
    const after = await labels();
    assert.deepEqual(after.map(([name]) => name), before.map(([name]) => name), 'the same labels, widened');
    if (forcedFonts) assert.ok(after.every(([, , family]) => family.startsWith('Verdana')), `every label asks for the forced face: ${JSON.stringify(after)}`);
    else assert.deepEqual(after.map(([, , family]) => family), before.map(([, , family]) => family), 'every label keeps its own face');
    assert.ok(after.every(([, width], i) => width >= before[i][1] * 1.1), `every label is at least 10% wider: ${widths(before)} to ${widths(after)}`);
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
      for (const open of [false, true]) {
        if (open) {
          await press(chrome, "document.querySelector('#filter-toggle')");
          await chrome.waitFor("!document.querySelector('#filter-menu').hidden");
        }
        const at = `375/${scheme}/menu ${open ? 'open' : 'closed'}`;
        const measured = await fit();
        assert.ok(measured.toolbar[0] <= measured.toolbar[1] && measured.page[0] <= measured.page[1], `${at}: neither the toolbar nor the page scrolls sideways: ${JSON.stringify(measured)}`);
        assert.deepEqual(measured.past, [], `${at}: nothing reaches past the toolbar's edges (${measured.inside}): ${JSON.stringify(measured.past)}`);
        if (open) {
          await press(chrome, "document.querySelector('#detail')");
          await chrome.waitFor("document.querySelector('#filter-menu').hidden");
        }
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
};

test('the items toolbar fits at 375 with wide fonts [N26]', wideFontToolbar(true));

test('the wide-font widening holds without the forced fonts [N26]', wideFontToolbar(false));

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
test('the detail opens on the top item, not a blank form [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  // Beta's first row is #3, while its #1 and #2 share ids with alpha's first row and pick.
  const beta = project(box, 'beta');
  for (const title of ['Beta one', 'Beta two', 'Beta three']) await box.inProcess(beta.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  const empty = project(box, 'empty');
  const done = project(box, 'done');
  await box.inProcess(done.repo, 'add', 'web', 'Shipped page', '--specs', 'G1', '--criterion', 'renders');
  build(box, done, 1, 'shipped.html');
  accept(box, done, 1);
  const gone = project(box, 'gone');
  await box.inProcess(gone.repo, 'add', 'web', 'Dropped page', '--specs', 'G1', '--criterion', 'renders');
  await box.inProcess(gone.repo, 'withdraw', '1', 'nobody needs it');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    const shown = () => /<h2><span class="id">#(\d+)<\/span>([^<]*)</.exec(page.show('detail'))?.slice(1).join(' ');
    const rows = () => [...page.show('chain').matchAll(/<li class="(row s-[^"]+)" data-item="(\d+)"/g)].map((match) => match[2] + (match[1].split(/\s/u).includes('on') ? '*' : ''));
    const form = () => [page.element('add-form').hidden, page.element('detail').hidden];

    assert.equal(shown(), '2 Farewell', 'the first row, the item updated last');
    assert.deepEqual(rows(), ['2*', '1'], 'its row is marked');
    assert.deepEqual(form(), [true, false], 'no blank form');

    await box.inProcess(alpha.web, 'claim', '1');
    page.element('shout-to').value = 'web';
    page.element('shout-text').value = 'Greeting is claimed';
    await page.fire('shout-form', 'submit');
    assert.deepEqual(rows(), ['1', '2*'], 'the refresh put the claimed item first');
    assert.equal(shown(), '2 Farewell', 'and the pick held');

    await page.fire('new-item', 'click');
    assert.deepEqual(form(), [false, true], 'New item opens the form');
    assert.equal(page.element('add-cancel').hidden, false);
    await page.fire('add-cancel', 'click');
    assert.deepEqual(form(), [true, false], 'Cancel closes it');
    assert.equal(shown(), '2 Farewell', 'and brings back the item it covered');

    await page.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(shown(), '3 Beta three', "the new project's first row, not an id from alpha");
    assert.deepEqual(rows(), ['3*', '2', '1']);

    await page.click({ root: empty.repo, classes: 'proj side' });
    assert.deepEqual(form(), [false, true], 'a project with no items opens on the form');
    assert.equal(page.element('add-cancel').hidden, true, 'with nothing to go back to');

    await page.click({ root: done.repo, classes: 'proj side' });
    assert.deepEqual(rows(), [], 'Active shows nothing: the only item is verified');
    assert.deepEqual(form(), [true, false]);
    assert.match(page.show('detail'), /Pick an item to see its criterion, verdicts and history\./);

    await page.click({ root: gone.repo, classes: 'proj side' });
    assert.deepEqual(rows(), [], 'no chip lists the only item: it is withdrawn');
    assert.deepEqual(form(), [true, false], 'but an item exists, so no form');
    assert.match(page.show('detail'), /Pick an item to see its criterion, verdicts and history\./);
  } finally {
    await view.stop();
  }
});

test('a new item from the view can carry a brief [N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const add = async (fields) => {
      await page.fire('new-item', 'click');
      for (const [id, value] of Object.entries(fields)) page.element(id).value = value;
      await page.fire('add-form', 'submit');
      return page.element('console').textContent;
    };
    const stored = async (id) => JSON.parse(await box.inProcess(alpha.repo, 'show', String(id), '--json')).item_brief;

    const brief = 'Files: web/greeting.html\nTest: the page says hello';
    const ran = await add({ 'add-lane': 'web', 'add-title': 'Greeting', 'add-specs': 'G1', 'add-brief': brief });
    assert.ok(ran.startsWith(`$ pullboard add web Greeting --specs G1 --brief ${brief}\n`), ran);
    assert.equal(await stored(1), brief, 'the brief reaches the board as written, its line break kept');
    assert.equal(page.element('add-brief').value, '', 'a successful add clears it');

    const plain = await add({ 'add-lane': 'web', 'add-title': 'Farewell', 'add-specs': 'G2', 'add-brief': '  ' });
    assert.ok(plain.startsWith('$ pullboard add web Farewell --specs G2\n'), plain);
    assert.ok(!(await stored(2)), 'left empty, the item gets no brief');
    assert.match(page.html, /<label>Brief<textarea id="add-brief"/, 'the field is in the form, not built by the script');
  } finally {
    await view.stop();
  }
});

test("a finished action's output steps aside [N27]", async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // The page's timers, held by the test: each pending close is recorded and fired at will.
    page.run('globalThis.pause = setTimeout; globalThis.closes = []; globalThis.setTimeout = (run, ms) => closes.push({ run, ms, live: true }); globalThis.clearTimeout = (id) => { if (closes[id - 1]) closes[id - 1].live = false; };');
    const pending = () => JSON.parse(page.run('JSON.stringify(closes.map((close) => [close.ms, close.live]))'));
    const out = page.element('console');
    const shout = async (to, text) => {
      page.element('shout-to').value = to;
      page.element('shout-text').value = text;
      await page.fire('shout-form', 'submit');
    };

    await shout('web', 'hello');
    assert.match(out.textContent, /^\$ pullboard shout web hello\n/);
    assert.deepEqual([out.className, out.hidden], ['console ok', false]);
    assert.deepEqual(pending(), [[6000, true]], 'a close six seconds on');
    page.run('closes[0].run()');
    assert.equal(out.hidden, true, 'and then the output steps aside');

    await shout('web', 'again');
    await shout('nobody-here', 'is anyone there');
    assert.match(out.textContent, /NO_READER/);
    assert.deepEqual([out.className, out.hidden], ['console no', false]);
    assert.deepEqual(pending().slice(1), [[6000, false]], 'the refusal cancelled the close the shout before it left, and set none');

    // Two shouts in flight: the first goes through but answers only after the second, a refusal, has
    // started. The first must not set a close that would hide the refusal.
    page.run('const plain = fetch; let sent = 0; globalThis.fetch = (path, init) => path.endsWith("/moves") ? new Promise((done) => pause(done, ++sent === 1 ? 300 : 900)).then(() => plain(path, init)) : plain(path, init);');
    await shout('web', 'first, and slow to answer');
    await shout('nobody-here', 'second, and refused');
    await new Promise((done) => setTimeout(done, 2000));
    await page.run('refresh()');
    assert.match(out.textContent, /NO_READER/, 'the later action owns the console');
    page.run('closes.filter((close) => close.live).forEach((close) => close.run())');
    assert.deepEqual([out.className, out.hidden], ['console no', false], 'and no close from the earlier success hides it');
  } finally {
    await view.stop();
  }
});
