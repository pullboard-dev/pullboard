// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: next-release folding and open releases, using the shared real-board fixtures [N26]. */
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
  target,
  accept,
  chromeExecutable,
  closeSnapshotChrome,
  press,
  settled,
  proofShot,
  pickProject,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  openRoadmapChrome,
  landRoadmapItem,
} from '../../../tests/fixtures/cockpit/roadmap.js';

test('the roadmap leads with the next release and folds shipped ones [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for roadmap browser checks.');
  const box = machine();
  const alpha = project(box, 'releases');
  for (const title of ['First page', 'Second page', 'Third page', 'Fourth page', 'Fifth page', 'Dropped idea']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2, 4]) { build(box, alpha, id, `page-${id}.html`); accept(box, alpha, id); landRoadmapItem(box, alpha, id); }
  box.run(alpha.repo, 'withdraw', '6', 'not needed');
  // In the board's order: two releases shipped (one with a withdrawn item, which does not hold it back), the next one
  // part done, and one queued after it.
  box.run(alpha.repo, 'milestone', 'add', '0.1', '--note', 'The first page.', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.2', '--note', 'Shipped on Tuesday.\nA second line the shipped row leaves out.', '--reason', 'Arrange fixture release', '--items', '2,6');
  box.run(alpha.repo, 'milestone', 'add', '0.3', '--note', 'Next out.', '--reason', 'Arrange fixture release', '--items', '3,4');
  box.run(alpha.repo, 'milestone', 'add', '0.4', '--note', 'Queued behind 0.3.', '--reason', 'Arrange fixture release', '--items', '5');
  box.run(alpha.repo, 'milestone', 'add', 'Later', '--note', 'Work not filed yet.');
  box.run(alpha.repo, 'milestone', 'move', 'Later', '--before', '0.1');
  box.run(alpha.repo, 'milestone', 'ship', '0.1', '--next', '0.3');
  box.run(alpha.repo, 'milestone', 'ship', '0.2', '--next', '0.3', '--as', 'person', '--reason', 'Arrange fixture release'); // a second ship is the person's past the coordinator-actions ratchet
  const shippedCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const other = project(box, 'other-releases');
  box.run(other.repo, 'add', 'web', 'Other next page', '--specs', 'G1', '--criterion', 'renders');
  box.run(other.repo, 'milestone', 'add', '0.3', '--reason', 'Arrange fixture release', '--items', '1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-releases-chrome-'));
  let chrome;
  /** The Roadmap as it reads: each part in order, open or closed, with what its summary says. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    /** Read header columns without the decorative caret. */
    // A release with work left opens from the shared release header (0ab202b994): read its name and landed count, not
    // its time-dependent forecast, which apps/cli/journeys/release/header.test.js checks.
    const words = (e) => [...(e.querySelector(':scope > .release-header-top')?.children ?? e.children)].filter((c) => !c.classList.contains('caret') && !c.matches('.roadmap-shipped-commit, .roadmap-forecast')).map((c) => c.matches('.roadmap-left') ? c.querySelector('[aria-label]').getAttribute('aria-label') : c.textContent.replace(/\\s+/g, ' ').trim()).join(' | ');
    /** Measure the rendered header target. */
    const box = (e) => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height }; };
    /** Find the direct disclosure control. */
    const head = (part) => part.querySelector(':scope > .milestone-head, :scope > .release-header > .milestone-head');
    /** Find the direct disclosure contents. */
    const body = (part) => part.querySelector(':scope > .milestone-body');
    /** Read the accessible expanded state. */
    const open = (part) => head(part)?.getAttribute('aria-expanded') === 'true';
    /** Read only visible item rows from an expanded release. */
    const rows = (part) => open(part) ? [...body(part).querySelectorAll(':scope > ul .milestone-item')].filter((row) => row.getBoundingClientRect().height > 0).map((row) => row.querySelector('.id').textContent) : [];
    return {
      statusRelease: document.querySelector('[data-status=release]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      parts: [...document.querySelectorAll('#roadmap-list > [data-key]')].map((d) => ({ key: d.dataset.key, open: open(d), summary: words(head(d)), height: box(head(d)).height,
        rows: rows(d), empty: body(d).querySelector('.milestone-empty')?.textContent ?? null, note: body(d).querySelector('.milestone-note')?.textContent ?? null,
        shipped: [...body(d).querySelectorAll(':scope > .shipped-one[data-key]')].map((one) => ({ key: one.dataset.key, open: open(one), summary: words(head(one)), height: box(head(one)).height,
          rows: rows(one), commit: one.querySelector('.roadmap-shipped-commit')?.title, copySeparate: !!one.querySelector('.hash-copy') && !one.querySelector('.hash-copy').closest('[role="button"]') })) })),
    };
  })())`));
  /** Activate a disclosure or item through the shared native pointer helper. */
  const click = (selector) => press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.milestones?.length === 5");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelectorAll('#roadmap-list > [data-key]').length > 0");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.stable("delete document.documentElement.dataset.theme");
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.equal(r.statusRelease, '0.3 1/2', at + ': the status bar names the same next release');
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll`);
        // Every release with work ahead stays open; the shipped ones fold into one part at the end.
        assert.deepEqual(r.parts.map((part) => [part.key, part.open, part.summary]), [
          ['m:0.3', true, '0.3 | 1/2 landed'],
          ['m:0.4', true, '0.4 | 0/1 landed'],
          ['m:Later', true, 'Later'],
          ['shipped', false, 'Shipped | 2 releases'],
        ], `${at}: every upcoming milestone opens in order, with Shipped folded last`);
        assert.deepEqual(r.parts[0].rows, ['#3', '#4'], `${at}: the next release shows its items`);
        assert.deepEqual([r.parts[2].empty, r.parts[2].note], ['No items yet.', 'Work not filed yet.'], `${at}: the open empty milestone shows its note and empty state`);
        assert.ok(r.parts.every((part) => part.height >= 44), `${at}: each part opens from a 44px target`);
        await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
        const expanded = await read();
        const history = expanded.parts.find((part) => part.key === 'shipped');
        assert.deepEqual(history.shipped.map((one) => [one.key, one.open, one.summary]), [
          ['m:0.2', false, '0.2 | Shipped on Tuesday. | 1 item'],
          ['m:0.1', false, '0.1 | The first page. | 1 item'],
        ], at + ': shipped names, first note line and counts in reverse roadmap order');
        assert.ok(history.shipped.every((one) => one.commit === shippedCommit && one.copySeparate), at + ': each shipment displays its real commit with a copy control outside the disclosure');
        assert.ok(history.shipped.every((one) => one.height >= 44), at + ': shipped targets are at least 44px');
        assert.ok(expanded.page.scroll <= expanded.page.width && expanded.page.body <= expanded.page.width, at + ': expanded history has no sideways scroll');
        await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
        assert.deepEqual((await read()).parts.find((part) => part.key === 'shipped').shipped[0].rows, ['#2'], at + ': verified items remain readable and withdrawn work is absent');
        await proofShot(chrome, 'releases', width);
        await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
        await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
      }
    }

    // Opened, Shipped lists the releases newest first: each its name, its note's first line and its item count; one
    // opens to its items as before.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await press(chrome, "document.querySelector('[data-status=release]')");
    assert.deepEqual((await read()).parts.map(part => part.key), ['m:0.3'], 'the status-bar release link opens only the same next release');
    await press(chrome, "document.querySelector('[data-roadmap-all]')");
    assert.deepEqual((await read()).parts.map(part => part.key), ['m:0.3', 'm:0.4', 'm:Later', 'shipped'], 'show all restores upcoming and shipped history');
    await click('#roadmap-list > [data-key="shipped"] > .milestone-head');
    let r = await read();
    const shipped = r.parts.find((part) => part.key === 'shipped');
    assert.deepEqual(shipped.shipped.map((one) => [one.key, one.open, one.summary]), [
      ['m:0.2', false, '0.2 | Shipped on Tuesday. | 1 item'],
      ['m:0.1', false, '0.1 | The first page. | 1 item'],
    ], 'newest first, each one line, closed');
    assert.ok(shipped.shipped.every((one) => one.height >= 44), 'each a 44px target');
    await click('#roadmap .shipped-one[data-key="m:0.2"] > .milestone-head');
    r = await read();
    assert.deepEqual(r.parts.find((part) => part.key === 'shipped').shipped.find((one) => one.key === 'm:0.2').rows, ['#2'], 'a shipped release opens to its verified items');
    await click('#roadmap .shipped-one[data-key="m:0.2"] .milestone-item');
    await click('#roadmap .shipped-one[data-key="m:0.2"] .milestone-why a[data-go="item:2"]');
    await chrome.waitFor("view.tab === 'items' && document.querySelector('#detail h2')?.textContent.includes('Second page')");

    // The parts stay as the person left them when the board redraws: close the next release, then change the board.
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden");
    await click('#roadmap-list > [data-key="m:0.3"] > .release-header > .milestone-head'); // the shared release header holds the head (0ab202b994)
    box.run(alpha.web, 'claim', '3');
    await chrome.waitFor("data.project.items.find((i) => i.id === 3)?.status === 'claimed'", 15_000); // budget: hang ceiling for the native claim to reach the open roadmap; no throughput claim.
    r = await read();
    assert.deepEqual(r.parts.map((part) => [part.key, part.open]), [['m:0.3', false], ['m:0.4', true], ['m:Later', true], ['shipped', true]], 'a redraw keeps each part as it was left');
    await pickProject(chrome, `[...document.querySelectorAll('[data-root]')].find((e) => e.dataset.root === ${JSON.stringify(other.repo)})`);
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', true]], 'another board starts with its own next release open');
    await pickProject(chrome, `[...document.querySelectorAll('[data-root]')].find((e) => e.dataset.root === ${JSON.stringify(alpha.repo)})`);
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', false], ['m:0.4', true], ['m:Later', true], ['shipped', true]], 'returning to the board preserves this visit\'s disclosure choices');
    await chrome.send('Page.reload');
    await settled(chrome, "typeof data === 'object' && data?.project?.milestones?.length === 5 && !document.querySelector('[data-pane=roadmap]').hidden");
    assert.deepEqual((await read()).parts.map((part) => [part.key, part.open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], 'a new visit opens every upcoming milestone and folds Shipped again');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
