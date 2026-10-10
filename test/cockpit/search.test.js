/** Cockpit search checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC, machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, searchFor } from './fixture.js';


test('search in the top bar finds anything on the board [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search checks.');
  const box = machine();
  const spec = `${SPEC}- G3 [approved, must] The greeting names the visitor. | gate: web test\n`;
  const alpha = project(box, 'finder', spec, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n');
  box.run(alpha.repo, 'add', 'web', 'Farewell page', '--specs', 'G1', '--criterion', 'renders');
  // Seven items match, so the Items group shows five of them and says how many there are.
  for (let n = 1; n <= 7; n += 1) box.run(alpha.repo, 'add', 'web', `Greeting variant ${n}`, '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.web, 'shout', 'coordinator', 'The greeting is ready for review.');
  box.run(alpha.web, 'shout', 'coordinator', 'Should the greeting wave?', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-finder-chrome-'));
  let chrome;
  /** The top bar's search and its results as they read. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const results = document.querySelector('#find-results');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      inTop: !!document.querySelector('.top .top-find #q'), toolbar: [...document.querySelector('.toolbar').children].filter((e) => e.offsetParent !== null || e.tagName === 'SELECT').map((e) => e.id || e.className),
      field: box(document.querySelector('#q')), tabs: box(document.querySelector('#tabs')), top: box(document.querySelector('header.top')), theme: box(document.querySelector('#theme')),
      bar: [...document.querySelectorAll('.toolbar #state-chips button, .toolbar #lane-pick, .toolbar #new-item')].filter((e) => e.getClientRects().length > 0)
        .map((e) => ({ name: e.dataset.state || e.id, on: e.classList.contains('on'), middle: Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2) })),
      shoutIds: data.project.shouts.map((x) => '#' + x.shout_id), focused: document.activeElement?.id ?? null, value: document.querySelector('#q').value,
      shown: !results.hidden, groups: [...results.querySelectorAll('h4')].map((h) => [h.firstChild.textContent, h.querySelector('span').textContent]),
      hits: [...results.querySelectorAll('.find-hit')].map((hit) => ({ go: hit.dataset.find, id: hit.querySelector('code').textContent, note: hit.querySelector('small').textContent, on: hit.classList.contains('on') })),
      tab: view.tab, item: view.item, spec: view.row.spec, doctrine: view.row.doctrine,
    };
  })())`));
  const key = async (name, code, keyCode, text) => {
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) });
  };
  const tap = async (selector) => {
    const point = JSON.parse(await chrome.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    for (const type of ['mousePressed', 'mouseReleased']) await chrome.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  const search = (words) => searchFor(chrome, words);
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 8 && data.project.shouts.length >= 2");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        await chrome.evaluate("document.querySelector('[data-tab=items]').click()");
        const at = `${width}px ${scheme}`;
        // The Items toolbar is one row: Active, Verified and All, the lane picker, New item at its end; on a phone Active
        // and Verified with New item, All and the lane picker dropped.
        const bar = (await read()).bar, names = bar.map((part) => part.name);
        if (width === 375) assert.deepEqual(names, ['active', 'verified', 'new-item'], `${at}: on a phone the toolbar is Active, Verified and New item`);
        else assert.deepEqual([names.slice(0, 3), names.at(-1)], [['active', 'verified', 'all'], 'new-item'], `${at}: the toolbar's states, then New item at its end`);
        assert.ok(bar.every((part) => Math.abs(part.middle - bar[0].middle) <= 2), `${at}: the toolbar is one row: ${JSON.stringify(bar)}`);
        await search('greeting');
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        // The search is the top bar's; the Items toolbar keeps the states, the lane picker and New item.
        assert.ok(r.inTop, `${at}: the search sits in the top bar`);
        assert.deepEqual(r.toolbar, ['state-chips', 'lane-pick', 'new-item'], `${at}: the Items toolbar has no search field`);
        if (width === 375) assert.ok(r.field.top >= r.tabs.bottom - 1 && r.field.width >= r.page.width - 40, `${at}: on a phone the search is its own row under the tabs: ${JSON.stringify([r.field, r.tabs])}`);
        else assert.ok(Math.abs((r.field.top + r.field.height / 2) - (r.top.top + r.top.height / 2)) <= 2 && r.field.left >= r.tabs.right && r.field.right <= r.theme.left, `${at}: the search sits in the top bar between the tabs and the theme button: ${JSON.stringify([r.tabs, r.field, r.theme, r.top])}`);
        // Results group by kind, five a group with how many there are, the first ready for Enter.
        assert.deepEqual(r.groups, [['Items', '5 of 7'], ['Spec', '1'], ['Doctrine', '1'], ['Shouts', '2']], `${at}: grouped, newest first, five a group`);
        assert.deepEqual([r.hits.length, r.hits.findIndex((hit) => hit.on), r.hits.slice(5).map((hit) => hit.id)], [9, 0, ['G3', 'R1', ...r.shoutIds]], `${at}: every group's results, the first highlighted`);
        // A shout's result is its own id, its words and its kind, newest first.
        assert.deepEqual(r.hits.slice(7).map((hit) => hit.note), ['decision', 'shout'], `${at}: a shout's result names its kind: ${JSON.stringify(r.hits.slice(7))}`);
        await key('Escape', 'Escape', 27);
        const cleared = await read();
        assert.deepEqual([cleared.value, cleared.shown], ['', false], `${at}: Esc clears the search and closes its results`);
      }
    }

    // A search begun straight after Esc keeps its results: leaving the field closes them a moment later, and coming back
    // before then must not let that close take the new ones (CI lost them this way between searches, #394).
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await search('greeting');
    await key('Escape', 'Escape', 27);
    await search('greeting');
    await chrome.evaluate('new Promise((done) => setTimeout(done, 250))');
    const kept = JSON.parse(await chrome.evaluate("JSON.stringify([document.querySelector('#q').value, document.activeElement.id, document.querySelector('#find-results').hidden])"));
    assert.deepEqual(kept, ['greeting', 'q', false], `a search straight after Esc keeps its results (words, focus, results hidden): ${JSON.stringify(kept)}`);
    await key('Escape', 'Escape', 27);
    assert.equal(await chrome.evaluate("document.querySelector('#find-results').dataset.why"), 'escape', 'Esc closes the results and says so');

    // The arrows move the highlight and Enter opens it: here the third item, the third newest.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await search('greeting');
    let r = await read();
    const third = r.hits[2].go;
    await key('ArrowDown', 'ArrowDown', 40);
    await key('ArrowDown', 'ArrowDown', 40);
    assert.equal((await read()).hits.findIndex((hit) => hit.on), 2, 'down twice highlights the third');
    await key('ArrowUp', 'ArrowUp', 38);
    await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13, '\r');
    await chrome.waitFor(`view.tab === 'items' && view.item === ${Number(third.slice(5))} && document.querySelector('#find-results').hidden`);

    // On a phone, a search that opens an item shows All, since All is then the selected filter, so the person sees where
    // they are and can leave it; Active again drops All.
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === 375 && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      await search('greeting');
      await key('Enter', 'Enter', 13, '\r');
      await chrome.waitFor("view.tab === 'items' && !!view.item && document.querySelector('#find-results').hidden");
      const opened = (await read()).bar;
      assert.deepEqual(opened.map((part) => [part.name, part.on]), [['active', false], ['verified', false], ['all', true], ['new-item', false]], `375px ${scheme}: a search that opens an item shows All, selected: ${JSON.stringify(opened)}`);
      assert.ok(opened.every((part) => Math.abs(part.middle - opened[0].middle) <= 2), `375px ${scheme}: still one row: ${JSON.stringify(opened)}`);
      await chrome.evaluate("document.querySelector('[data-state=active]').click()");
      assert.deepEqual((await read()).bar.map((part) => part.name), ['active', 'verified', 'new-item'], `375px ${scheme}: back on Active, All drops again`);
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');

    // Spec rows and Doctrine rules read newest first by when each was added, not by where it sits in its file: R1 is
    // committed, then R2 and G4 appended, then G5 inserted above G3.
    box.git(alpha.repo, 'add', 'ways.md');
    box.git(alpha.repo, 'commit', '-q', '-m', 'docs(rules): keep the local rules [G1]');
    writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n- R2 [approved, must] A greeting never shouts. | gate: review\n');
    writeFileSync(join(alpha.repo, 'SPEC.md'), `${spec}- G4 [approved, must] The greeting waves back. | gate: web test\n`);
    box.git(alpha.repo, 'commit', '-q', '-am', 'docs(spec): the greeting waves back [G1]');
    writeFileSync(join(alpha.repo, 'SPEC.md'), spec.replace('- G3 ', '- G5 [approved, must] The greeting fits a phone. | gate: web test\n- G3 ') + '- G4 [approved, must] The greeting waves back. | gate: web test\n');
    box.git(alpha.repo, 'commit', '-q', '-am', 'docs(spec): the greeting fits a phone [G1]');
    await chrome.waitFor("data.project.spec.some((row) => row.id === 'G5') && data.project.practice.some((row) => row.id === 'R2')", 15_000);
    await search('greeting');
    const added = (await read()).hits.filter((hit) => /^(spec|doctrine):/.test(hit.go)).map((hit) => hit.id);
    assert.deepEqual(added, ['G5', 'G4', 'G3', 'R2', 'R1'], `Spec and Doctrine newest first by when each row was added: ${JSON.stringify(added)}`);
    await key('Escape', 'Escape', 27);

    // A click opens a Spec row, a Doctrine rule or a shout where it lives.
    await search('greeting');
    await tap('#find-results [data-find="spec:G3"]');
    await chrome.waitFor("view.tab === 'spec' && view.row.spec === 'G3' && document.querySelector('#spec-detail h2 span')?.textContent === 'G3'");
    await search('greeting');
    await tap('#find-results [data-find="doctrine:R1"]');
    await chrome.waitFor("view.tab === 'doctrine' && view.row.doctrine === 'R1' && document.querySelector('#doctrine-detail h2 span')?.textContent === 'R1'");
    await search('greeting');
    const shout = (await read()).hits.find((hit) => hit.go.startsWith('shout:')).go;
    await tap(`#find-results [data-find="${shout}"]`);
    await chrome.waitFor(`view.tab === 'shouts' && document.getElementById('shout-${shout.slice(6)}')?.classList.contains('found')`);

    // "/" goes to the search from the page, never from a field.
    await chrome.evaluate("document.activeElement.blur(); document.body.focus()");
    await key('/', 'Slash', 191, '/');
    r = await read();
    const selected = await chrome.evaluate("(() => { const q = document.querySelector('#q'); return q.selectionStart === 0 && q.selectionEnd === q.value.length; })()");
    assert.deepEqual([r.focused, selected], ['q', true], '"/" puts the cursor in the search, its last words selected to type over');
    await chrome.evaluate("document.querySelector('#shout-text').focus()");
    await key('/', 'Slash', 191, '/');
    assert.equal(await chrome.evaluate("document.querySelector('#shout-text').value"), '/', 'and in a field it is only a slash');

    // On a phone the lane picker shows while a lane narrows the list, so the person sees where they are and can leave
    // it; with every lane shown it drops again. A coordinator item makes a second lane to pick between.
    box.run(alpha.repo, 'add', 'coordinator', 'Plan the greeting release', '--criterion', 'planned');
    await chrome.waitFor('data.project.items.length === 9', 15_000);
    const lane = (name) => chrome.evaluate(`(() => { const pick = document.querySelector('#lane-pick'); pick.value = ${JSON.stringify(name)}; pick.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === 1280 && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      await chrome.evaluate("document.querySelector('[data-tab=items]').click(); document.querySelector('[data-state=active]').click()");
      await lane('web');
      await chrome.waitFor("view.lane === 'web'");
      assert.ok((await read()).bar.some((part) => part.name === 'lane-pick'), `1280px ${scheme}: the lane picker is in the toolbar`);
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === 375');
      const narrowed = await read();
      assert.deepEqual(narrowed.bar.map((part) => part.name), ['active', 'verified', 'lane-pick', 'new-item'], `375px ${scheme}: a picked lane keeps its picker: ${JSON.stringify(narrowed.bar)}`);
      assert.ok(narrowed.bar.every((part) => Math.abs(part.middle - narrowed.bar[0].middle) <= 2) && narrowed.page.scroll <= narrowed.page.width, `375px ${scheme}: still one row, no sideways scroll: ${JSON.stringify(narrowed)}`);
      // With the lane still picked, a search that opens an item makes All the selected filter too: both filters show,
      // New item is a + that is still named New item, and the row holds.
      await search('greeting');
      await key('Enter', 'Enter', 13, '\r');
      await chrome.waitFor("view.tab === 'items' && !!view.item && view.state === 'all' && view.lane === 'web' && document.querySelector('#find-results').hidden");
      const both = await read();
      assert.deepEqual(both.bar.map((part) => [part.name, part.on]), [['active', false], ['verified', false], ['all', true], ['lane-pick', false], ['new-item', false]], `375px ${scheme}: All and the picked lane both show: ${JSON.stringify(both.bar)}`);
      assert.ok(both.bar.every((part) => Math.abs(part.middle - both.bar[0].middle) <= 2) && both.page.scroll <= both.page.width && both.page.body <= both.page.width, `375px ${scheme}: both filters on one row, no sideways scroll: ${JSON.stringify(both)}`);
      assert.deepEqual(JSON.parse(await chrome.evaluate("JSON.stringify((() => { const go = document.querySelector('#new-item'); return [go.textContent, getComputedStyle(go, '::before').content, Math.round(go.getBoundingClientRect().width)]; })())")), ['New item', '"+"', 44], `375px ${scheme}: New item is a 44px + that keeps its name`);
      // A long lane name gives way rather than the row: with the coordinator lane picked, still one row.
      await lane('coordinator');
      await chrome.waitFor("view.lane === 'coordinator'");
      const long = await read();
      assert.deepEqual(long.bar.map((part) => part.name), ['active', 'verified', 'all', 'lane-pick', 'new-item'], `375px ${scheme}: a long lane keeps every control: ${JSON.stringify(long.bar)}`);
      assert.ok(long.bar.every((part) => Math.abs(part.middle - long.bar[0].middle) <= 2) && long.page.scroll <= long.page.width && long.page.body <= long.page.width, `375px ${scheme}: a long lane name gives way, not the row: ${JSON.stringify(long)}`);
      await chrome.evaluate("document.querySelector('[data-state=active]').click()");
      await lane('');
      await chrome.waitFor('view.lane === null');
      assert.deepEqual((await read()).bar.map((part) => part.name), ['active', 'verified', 'new-item'], `375px ${scheme}: every lane shown, the picker drops again`);
      assert.equal(await chrome.evaluate("getComputedStyle(document.querySelector('#new-item'), '::before').content"), 'none', `375px ${scheme}: with only Active and Verified, New item has its words`);
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the search step names its state on timeout [N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search checks.');
  const box = machine();
  const alpha = project(box, 'stalled-search');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-stalled-search-chrome-'));
  let chrome;
  /** The record a timed-out search step carries, read from its message. */
  const record = (error) => JSON.parse(error.message.slice(error.message.indexOf('{')));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 1");
    // A field that takes no typing: the step times out, and its message says how far the search got.
    await chrome.evaluate("document.querySelector('#q').disabled = true");
    let stalled;
    await assert.rejects(searchFor(chrome, 'greeting', 1_500), (error) => { stalled = error; return true; });
    assert.match(stalled.message, /^the search for "greeting" did not show its results: \{/, 'the step says which search stalled');
    assert.deepEqual(Object.keys(record(stalled)), ['value', 'focused', 'windowFocus', 'resultsHidden', 'closedBy'], 'it records the value, the focus, the window focus, and the results with what closed them');
    assert.deepEqual([record(stalled).value, record(stalled).focused, typeof record(stalled).windowFocus, record(stalled).resultsHidden], ['', 'body', 'boolean', true], `no words reached the field, which never had focus: ${stalled.message}`);
    // Results that showed and were then closed say what closed them: here, leaving the field.
    await chrome.evaluate("document.querySelector('#q').disabled = false");
    await searchFor(chrome, 'greeting');
    await chrome.evaluate("document.querySelector('#q').blur()");
    await chrome.waitFor("document.querySelector('#find-results').hidden");
    assert.equal(await chrome.evaluate("document.querySelector('#find-results').dataset.why"), 'left the field', 'leaving the field closes the results and says so');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
