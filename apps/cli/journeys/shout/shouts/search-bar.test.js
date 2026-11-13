// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit top bar search finds anything [N26] */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import {
  fixtureAdd,
  fixtureProjectPolicy,
} from '../../../tests/fixtures/testkit.js';
import {
  SPEC,
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  searchFor,
  chooseFilter,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';

/** Rewrite a fixture's SPEC.md through the kit, keeping its pullboard.json as the project made it. */
function writeSpec(repo, spec) {
  fixtureProjectPolicy(repo, { config: JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8')), spec });
}

/** Wait for committed row order, rather than rows that may already be visible as uncommitted edits. */
async function committedRows(chrome, head) {
  await chrome.waitFor(`data?.project?.rowAgesAt?.['SPEC.md'] === ${JSON.stringify(head)} && data.project.rowAgesAt['ways.md'] === ${JSON.stringify(head)}`, 15_000); // budget: hang ceiling for the committed row-age snapshot to arrive; no throughput claim.
}

test('search in the top bar finds anything on the board [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for search checks.');
  const box = machine();
  const spec = `${SPEC}- G3 [approved, must] The greeting names the visitor. | gate: web test\n`;
  const alpha = project(box, 'finder', spec, { practice: 'ways.md' });
  writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n');
  fixtureAdd(box.run, alpha.repo, 'web', 'Farewell page', '--specs', 'G1', '--criterion', 'renders');
  // Seven items match, so the Items group shows five of them and says how many there are.
  // Each title differs in its own words so the add guard does not read them as duplicates [C7].
  for (const kind of ['banner', 'footer', 'wave', 'email', 'sound', 'badge', 'card']) fixtureAdd(box.run, alpha.repo, 'web', `Greeting ${kind} for the ${kind}-only landing`, '--specs', 'G1', '--criterion', `the ${kind} renders`, '--not-duplicate-of', '1 a fixture item for the search list, filed on purpose');
  await box.inProcess(alpha.web, 'shout', 'all', 'The greeting is ready for review.');
  await box.inProcess(alpha.web, 'shout', 'coordinator', 'Should the greeting wave?', '--decision', '--kind', 'question');
  const view = await startView(box);
  const profile = privateFixtureFiles('pullboard-finder-chrome-').root;
  let chrome;
  /** The top bar's search and its results as they read. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const results = document.querySelector('#find-results');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      inTop: !!document.querySelector('.top .top-find #q'), stripSearch: !!document.querySelector('#page-controls #q, #page-controls input'),
      field: box(document.querySelector('#q')), tabs: box(document.querySelector('#tabs')), tier: box(document.querySelector('.top-tier')), account: box(document.querySelector('#account')),
      bar: [...document.querySelectorAll('#page-controls [data-page-ctl]')].filter((e) => e.getClientRects().length > 0)
        .map((e) => ({ name: e.dataset.pageCtl + (e.dataset.value === undefined ? '' : ':' + e.dataset.value), on: e.getAttribute('aria-pressed') === 'true', middle: Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2) })),
      state: view.state, lane: view.lane, laneValue: document.querySelector('#page-controls select[data-page-ctl=lane]')?.value ?? null,
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
    await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  };
  /** The page-controls strip's parts in order: Show, Lane, View, then New item [N26]. */
  const stripNames = () => ['state:active', 'state:building', 'state:verify', 'state:all', 'lane', 'view:list', 'view:pipeline', 'new'];
  const search = (words) => searchFor(chrome, words);
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 8 && data.project.shouts.length >= 2");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        await chrome.click("document.querySelector('[data-tab=items]')");
        const at = `${width}px ${scheme}`;
        // The Items page controls are one strip: Show, View and New item.
        const bar = (await read()).bar, names = bar.map((part) => part.name);
        assert.deepEqual(names, stripNames(), `${at}: Show, View and New item share the strip`);
        assert.ok(bar.every((part) => Math.abs(part.middle - bar[0].middle) <= 2), `${at}: the strip controls are one row: ${JSON.stringify(bar)}`);
        await search('greeting');
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        // The search is the top bar's; the Items strip keeps its Show, View and New item controls.
        assert.ok(r.inTop, `${at}: the search sits in the top bar`);
        assert.equal(r.stripSearch, false, `${at}: the Items strip has no search field`);
        // At every width the search sits in the top tier, centred in it and left of the account control.
        assert.ok(Math.abs((r.field.top + r.field.height / 2) - (r.tier.top + r.tier.height / 2)) <= 2 && r.field.right <= r.account.left + 1, `${at}: the search sits in the top tier, left of the account control: ${JSON.stringify([r.tabs, r.field, r.account, r.tier])}`);
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
    await chrome.stable('new Promise((done) => setTimeout(done, 250))');
    const kept = JSON.parse(await chrome.stable("JSON.stringify([document.querySelector('#q').value, document.activeElement.id, document.querySelector('#find-results').hidden])"));
    assert.deepEqual(kept, ['greeting', 'q', false], `a search straight after Esc keeps its results (words, focus, results hidden): ${JSON.stringify(kept)}`);
    await key('Escape', 'Escape', 27);
    assert.equal(await chrome.stable("document.querySelector('#find-results').dataset.why"), 'escape', 'Esc closes the results and says so');

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

    // On a phone, a search that opens an item selects Show All, which can be changed back to Open.
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === 375 && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      await search('greeting');
      await key('Enter', 'Enter', 13, '\r');
      await chrome.waitFor("view.tab === 'items' && !!view.item && document.querySelector('#find-results').hidden");
      const opened = await read();
      assert.deepEqual([opened.state, opened.bar.filter((part) => part.on).map((part) => part.name)], ['all', ['state:all', 'view:list']], `375px ${scheme}: a search that opens an item selects All: ${JSON.stringify(opened.bar)}`);
      assert.deepEqual(opened.bar.map((part) => part.name), stripNames(), `375px ${scheme}: the strip retains its controls: ${JSON.stringify(opened.bar)}`);
      assert.ok(opened.bar.every((part) => Math.abs(part.middle - opened.bar[0].middle) <= 2), `375px ${scheme}: still one row: ${JSON.stringify(opened)}`);
      await chooseFilter(chrome, 'state:active');
      assert.equal((await read()).state, 'active', `375px ${scheme}: back on Open, All is cleared`);
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');

    // Spec rows and Doctrine rules read newest first by when each was added, not by where it sits in its file: R1 is
    // committed, then R2 and G4 appended, then G5 inserted above G3.
    box.git(alpha.repo, 'add', 'ways.md');
    box.git(alpha.repo, 'commit', '-q', '-m', 'docs(rules): keep the local rules [G1]');
    writeFileSync(join(alpha.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Every greeting is read by a person. | gate: review\n- R2 [approved, must] A greeting never shouts. | gate: review\n');
    writeSpec(alpha.repo, `${spec}- G4 [approved, must] The greeting waves back. | gate: web test\n`);
    box.git(alpha.repo, 'commit', '-q', '-am', 'docs(spec): the greeting waves back [G1]');
    writeSpec(alpha.repo, spec.replace('- G3 ', '- G5 [approved, must] The greeting fits a phone. | gate: web test\n- G3 ') + '- G4 [approved, must] The greeting waves back. | gate: web test\n');
    box.git(alpha.repo, 'commit', '-q', '-am', 'docs(spec): the greeting fits a phone [G1]');
    // The working file can expose G5 before its commit: compare only after the page captures the completed commit.
    await committedRows(chrome, box.git(alpha.repo, 'rev-parse', 'HEAD'));
    await search('greeting');
    const added = (await read()).hits.filter((hit) => /^(spec|doctrine):/.test(hit.go)).map((hit) => hit.id);
    const ageProof = JSON.parse(await chrome.stable('JSON.stringify({ captured: data.project.rowAgesAt ?? null, spec: data.project.spec.map(({ id, added }) => ({ id, added })), doctrine: data.project.practice.map(({ id, added }) => ({ id, added })) })'));
    assert.deepEqual(added, ['G5', 'G4', 'G3', 'R2', 'R1'], `Spec and Doctrine newest first by when each row was added: ${JSON.stringify({ added, ...ageProof, observed: box.git(alpha.repo, 'rev-parse', 'HEAD') })}`);
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

    // "/" opens the palette from the page, never from a field.
    await chrome.stable("document.activeElement.blur(); document.body.focus()");
    await key('/', 'Slash', 191, '/');
    assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify([!!document.querySelector('#pal-overlay .pal-box'), document.activeElement.id])")), [true, 'pal-q'], '"/" opens the palette with the cursor in its field');
    await key('Escape', 'Escape', 27);
    assert.equal(await chrome.stable("document.querySelector('#pal-overlay').innerHTML"), '', 'Esc closes it');
    await chrome.stable("document.querySelector('#shout-text').focus()");
    await key('/', 'Slash', 191, '/');
    assert.equal(await chrome.stable("document.querySelector('#shout-text').value"), '/', 'and in a field it is only a slash');

    // On a phone the lane picker shows while a lane narrows the list, so the person sees where they are and can leave
    // it; with every lane shown it drops again. A coordinator item makes a second lane to pick between.
    fixtureAdd(box.run, alpha.repo, 'coordinator', 'Plan the greeting release', '--criterion', 'planned');
    await chrome.waitFor('data.project.items.length === 9', 15_000);
    /** Pick a lane in the strip's Lane select. */
    const lane = (name) => chooseFilter(chrome, `lane:${name}`);
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === 1280 && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      await chrome.click("document.querySelector('[data-tab=items]')"); await chooseFilter(chrome, 'state:active');
      await lane('web');
      await chrome.waitFor("view.lane === 'web'");
      assert.equal((await read()).laneValue, 'web', `1280px ${scheme}: the selected lane shows in the Lane select`);
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === 375');
      const narrowed = await read();
      assert.deepEqual(narrowed.bar.map((part) => part.name), stripNames(), `375px ${scheme}: a picked lane keeps all strip controls: ${JSON.stringify(narrowed.bar)}`);
      assert.ok(narrowed.bar.every((part) => Math.abs(part.middle - narrowed.bar[0].middle) <= 2) && narrowed.page.scroll <= narrowed.page.width, `375px ${scheme}: still one row, no sideways scroll: ${JSON.stringify(narrowed)}`);
      // With the lane still picked, a search that opens an item makes All the selected Show too, and the lane stays.
      await search('greeting');
      await key('Enter', 'Enter', 13, '\r');
      await chrome.waitFor("view.tab === 'items' && !!view.item && view.state === 'all' && view.lane === 'web' && document.querySelector('#find-results').hidden");
      const both = await read();
      assert.deepEqual([both.state, both.laneValue, both.bar.map((part) => part.name)], ['all', 'web', stripNames()], `375px ${scheme}: All and the picked lane both show: ${JSON.stringify([both.state, both.laneValue, both.bar])}`);
      assert.ok(both.bar.every((part) => Math.abs(part.middle - both.bar[0].middle) <= 2) && both.page.scroll <= both.page.width && both.page.body <= both.page.width, `375px ${scheme}: both filters on one row, no sideways scroll: ${JSON.stringify(both)}`);
      assert.equal(await chrome.stable("document.querySelector('[data-page-ctl=new]').innerText"), 'New item', `375px ${scheme}: New item keeps its name below 900px`);
      // A long lane name gives way rather than the row: with the coordinator lane picked, still one row.
      await lane('coordinator');
      await chrome.waitFor("view.lane === 'coordinator'");
      const long = await read();
      assert.deepEqual(long.bar.map((part) => part.name), stripNames(), `375px ${scheme}: a long lane keeps every control: ${JSON.stringify(long.bar)}`);
      assert.ok(long.bar.every((part) => Math.abs(part.middle - long.bar[0].middle) <= 2) && long.page.scroll <= long.page.width && long.page.body <= long.page.width, `375px ${scheme}: a long lane name gives way, not the row: ${JSON.stringify(long)}`);
      await chooseFilter(chrome, 'state:active');
      await lane('');
      await chrome.waitFor('view.lane === null');
      assert.deepEqual((await read()).bar.map((part) => part.name), stripNames(), `375px ${scheme}: every lane shown, all controls remain`);
      assert.equal(await chrome.stable("document.querySelector('[data-page-ctl=new]').innerText"), 'New item', `375px ${scheme}: New item stays named when filters clear`);
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
