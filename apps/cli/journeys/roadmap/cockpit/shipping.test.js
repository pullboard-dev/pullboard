// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: shipping order, chip scroll and named waits, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  build,
  startView,
  accept,
  chromeExecutable,
  closeSnapshotChrome,
  press,
  settled,
  proofShot,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  openRoadmapChrome,
  landRoadmapItem,
} from '../../../tests/fixtures/cockpit/roadmap.js';

test('a milestone lists work to ship first, shipped below, and no withdrawn items [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for shipping-order checks.');
  const box = machine();
  const alpha = project(box, 'shipping-rows');
  for (const title of ['First verified', 'First open', 'Second verified', 'Dropped idea', 'Second open']) {
    await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  }
  for (const id of [1, 3]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); landRoadmapItem(box, alpha, id); }
  await box.inProcess(alpha.repo, 'withdraw', '4', 'not needed');
  // Placing an item in an open release takes it out of the other open ones (2a3a0f7555), so Shipped ships before Next
  // takes the same items; a shipped release keeps its history.
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Shipped', '--reason', 'Arrange fixture release', '--items', '1,4,3');
  await box.inProcess(alpha.repo, 'milestone', 'ship', 'Shipped');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '3,2,4,1,5');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shipping-rows-chrome-'));
  let chrome;
  /** Read the actual row order and every visible-count consumer, including folded history. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const next = document.querySelector('#roadmap-list > [data-key="m:Next"]');
    const progress = next.querySelector('.roadmap-summary-bar');
    const shipped = document.querySelector('#roadmap .shipped-one[data-key="m:Shipped"]');
    return {
      rows: [...next.querySelectorAll(':scope > .milestone-body > ul .milestone-item .id')].map(id => id.textContent),
      count: next.querySelector('.roadmap-left [aria-label]').getAttribute('aria-label'),
      progress: [progress.querySelector('[data-summary-segment=landed]').dataset.count, progress.dataset.total],
      index: document.querySelector('#roadmap-panel [data-roadmap-jump="m:Next"] b').textContent,
      status: document.querySelector('[data-status=release]').textContent.replace(/\\s+/g, ' ').trim(),
      // Desktop and phone each render the shipping counts; only the panel shown at this width counts (cead5a98d7).
      openCounts: [...document.querySelectorAll('[data-shipping-stage=waiting] dd')].filter(count => count.getClientRects().length > 0).map(count => count.textContent),
      headerWaiting: next.querySelector('[data-summary-state=waiting] b').textContent,
      shippedCount: shipped.querySelector('.milestone-count').textContent,
      shippedRows: [...shipped.querySelectorAll(':scope > .milestone-body > ul .milestone-item .id')].map(id => id.textContent),
      allIds: [...document.querySelectorAll('#roadmap .milestone-item .id')].map(id => id.textContent),
    };
  })())`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 2');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('#roadmap-list > [data-key=\"m:Next\"]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const seen = await read();
      // Queued work leads in queue order, then other work, then landed items in landing order (36add4ed61, f8e8ce444a).
      assert.deepEqual(seen.rows, ['#2', '#5', '#1', '#3'], `${width}: work to ship leads, and landed items follow in landing order`);
      assert.equal(seen.count, '2/4 landed', `${width}: withdrawn work is absent from the card count`);
      assert.deepEqual(seen.progress, ['2', '4'], `${width}: progress counts only retained items`);
      assert.equal(seen.index, '2/4', `${width}: the release index uses the same count`);
      assert.equal(seen.status, 'Next 2/4', `${width}: the status bar names the same next release and count`);
      assert.deepEqual(seen.openCounts, ['2'], `${width}: the companion panel reads the supplied waiting count`);
      assert.equal(seen.headerWaiting, '2', `${width}: the header includes both waiting items`);
      assert.equal(seen.shippedCount, '2 items', `${width}: folded history excludes withdrawn work from its total`);
      assert.equal(seen.allIds.includes('#4'), false, `${width}: no withdrawn row is rendered, including folded history`);
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=shipped] > .milestone-head')");
      await press(chrome, "document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head')");
      await chrome.waitFor("document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head').getAttribute('aria-expanded') === 'true'");
      assert.deepEqual((await read()).shippedRows, ['#1', '#3'], `${width}: verified history remains available below the work to ship`);
      await press(chrome, "document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head')");
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=shipped] > .milestone-head')");
    }
    assert.deepEqual(chrome.exceptions, [], 'the shipping roadmap raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the roadmap chips keep their scroll through a redraw with wide fonts [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Roadmap chip row.');
  const box = machine();
  const alpha = project(box, 'roadmap-chips-wide');
  await box.inProcess(alpha.repo, 'add', 'web', 'Next release item', '--specs', 'G1', '--criterion', 'renders');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'The next release.', '--reason', 'Arrange fixture release', '--items', '1');
  for (const name of ['0.8.8', '0.8.9', '0.8.10', '0.8.11', '0.8.12', '0.8.13', '0.8.14', '0.8.15', '0.8.16', '0.8.17', '0.8.18', '0.8.19']) {
    await box.inProcess(alpha.repo, 'milestone', 'add', name, '--note', 'Queued after the next release.');
  }
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-chips-wide-'));
  let chrome;
  /** The chips' release names by their text's own width, measured from the glyphs, not the boxes. */
  const labels = async () => JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#roadmap-releases .roadmap-release > span')].map((e) => { const r = document.createRange(); r.selectNodeContents(e); return [e.textContent, r.getBoundingClientRect().width]; }))"));
  const widths = (list) => JSON.stringify(list.map(([name, width]) => [name, Math.round(width * 100) / 100]));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 13');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("document.querySelector('#roadmap-releases [aria-current=location]')");
    const before = await labels();
    // The current release's chip is bold, so it is wider than when it is not marked, by an amount that depends on
    // the face: 2px on macOS, 4px on Linux CI (#452). A letter-spacing in em widens every label by the same share of its
    // face on every runner, as the toolbar's test does (#445); the forced face, where a machine has it, adds a wider bold.
    for (const face of ['', 'font-family: Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif !important; ']) {
      const at = `375/${face ? 'forced face' : 'own face'}`;
      await chrome.stable(`(() => { const sheet = document.styleSheets[0]; sheet.insertRule('.roadmap-release, .roadmap-release * { ${face}letter-spacing: .12em !important; }', sheet.cssRules.length); return true; })()`);
      const after = await labels();
      assert.deepEqual(after.map(([name]) => name), before.map(([name]) => name), `${at}: the same chips, widened`);
      assert.ok(after.every(([, width], i) => width >= before[i][1] * 1.1), `${at}: every chip's name is at least 10% wider: ${widths(before)} to ${widths(after)}`);
      // A board refresh redraws the Roadmap with the chips scrolled to their end, where a shorter row would clamp them.
      const kept = JSON.parse(await chrome.stable("(() => { const row = document.querySelector('#roadmap-releases'); row.scrollLeft = row.scrollWidth; const before = [row.scrollLeft, row.querySelector('[aria-current]')?.dataset.roadmapJump]; render(); const now = document.querySelector('#roadmap-releases'); return JSON.stringify([before, [now.scrollLeft, now.querySelector('[aria-current]')?.dataset.roadmapJump]]); })()"));
      assert.ok(kept[0][0] > 0 && kept[1][0] === kept[0][0], `${at}: a redraw keeps the chips exactly where they were scrolled: ${JSON.stringify(kept)}`);
      assert.equal(kept[1][1], kept[0][1], `${at}: the redraw keeps the same chip marked`);
      await chrome.stable("(() => { const sheet = document.styleSheets[0]; sheet.deleteRule(sheet.cssRules.length - 1); document.querySelector('#roadmap-releases').scrollLeft = 0; return true; })()");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a roadmap case that times out names the page state and its waiting step [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the roadmap diagnostics need real Chrome');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-wait-'));
  let chrome;
  try {
    chrome = await openRoadmapChrome(executable, 'about:blank', profile);
    let failure = null;
    const neverArrives = ['fal', 'se'].join('');
    try { await chrome.waitFor(neverArrives, 1_500); } catch (error) { failure = error; } // budget: hang ceiling for the control's own wait that never arrives; no throughput claim.
    assert.ok(failure, 'a wait that never arrives times out');
    assert.match(failure.message, /waiting for step: false/u, 'the timeout names the step it waited on');
    assert.match(failure.message, /the roadmap showed \{/u, 'a wait that never arrives names the roadmap state it saw');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the roadmap keeps every upcoming release open [N26]', {
  timeout: 90_000, //budget: real Chrome startup, two viewport layouts, and reload; test assertions bound each state.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for roadmap disclosure checks.');
  const box = machine();
  const alpha = project(box, 'all-upcoming-open');
  for (const title of ['Shipped one', 'Shipped two', 'Next release', 'Later release']) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); landRoadmapItem(box, alpha, id); }
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.1', '--reason', 'Arrange fixture release', '--items', '1');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.2', '--reason', 'Arrange fixture release', '--items', '2');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.3', '--note', 'Next out.', '--reason', 'Arrange fixture release', '--items', '3');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.4', '--note', 'Queued next.', '--reason', 'Arrange fixture release', '--items', '4');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Later', '--note', 'No work filed yet.');
  await box.inProcess(alpha.repo, 'milestone', 'ship', '0.1', '--next', '0.3');
  await box.inProcess(alpha.repo, 'milestone', 'ship', '0.2', '--next', '0.3', '--as', 'person', '--reason', 'Arrange fixture release'); // a second ship is the person's past the coordinator-actions ratchet
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-all-upcoming-open-chrome-'));
  let chrome;
  /** Read default disclosures, their visible content, status label, and viewport overflow. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const parts=[...document.querySelectorAll('#roadmap-list > [data-key]')];
    // A release with work left opens from the shared release header (0ab202b994).
    const readPart=part=>{const head=part.querySelector(':scope > .milestone-head, :scope > .release-header > .milestone-head'),body=part.querySelector(':scope > .milestone-body');
      const rows=[...body.querySelectorAll(':scope > ul .milestone-item')];
      return {key:part.dataset.key,open:head.getAttribute('aria-expanded')==='true',rows:rows.map(row=>row.querySelector('.id').textContent),visibleRows:rows.filter(row=>row.getBoundingClientRect().height>0).length,
        empty:body.querySelector('.milestone-empty')?.textContent??null,note:body.querySelector('.milestone-note')?.textContent??null,
        shipped:[...body.querySelectorAll(':scope > .shipped-one')].map(readPart)};};
    return {parts:parts.map(readPart),status:document.querySelector('[data-status=release]')?.textContent.replace(/\\s+/g,' ').trim()??null,
      viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth};
  })())`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.milestones?.length === 5");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 812 : 800, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const initial = await read();
      assert.deepEqual(initial.parts.map(({ key, open }) => [key, open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], `${width}: every upcoming release opens while Shipped stays folded`);
      assert.deepEqual(initial.parts.slice(0, 2).map((part) => [part.rows, part.visibleRows]), [[['#3'], 1], [['#4'], 1]], `${width}: both upcoming item lists are visible`);
      assert.deepEqual([initial.parts[2].empty, initial.parts[2].note], ['No items yet.', 'No work filed yet.'], `${width}: the empty upcoming release shows its note`);
      assert.equal(initial.parts[3].shipped.length, 2, `${width}: both shipped releases are present`);
      assert.equal(initial.parts[3].shipped.every((part) => !part.open && part.visibleRows === 0), true, `${width}: both shipped releases remain folded`);
      assert.equal(initial.status, '0.3 0/1', `${width}: the status bar still names the next release`);
      assert.ok(initial.scroll <= initial.viewport && initial.body <= initial.viewport, `${width}: no sideways scrolling`);
      await proofShot(chrome, 'roadmap-upcoming-open', width);
      if (width === 375) {
        await press(chrome, "document.querySelector('[data-roadmap-key=\"m:0.4\"]')");
        await chrome.waitFor("document.querySelector('[data-roadmap-key=\"m:0.4\"]').getAttribute('aria-expanded') === 'false'");
        assert.equal((await read()).parts[1].open, false, 'the person can fold an upcoming release for this visit');
        await chrome.send('Page.reload');
        await settled(chrome, "data?.project?.milestones?.length === 5 && !document.querySelector('[data-pane=roadmap]').hidden");
        assert.deepEqual((await read()).parts.map(({ key, open }) => [key, open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], 'the next visit reopens upcoming releases and folds Shipped');
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
