// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (detail) that fail at 375 px today, kept apart under #6797 so the rest of detail.test.js stays green [N26,B33,B29]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
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
  sendBack,
  startView,
  element,
  target,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  earlier,
} from '../../../tests/fixtures/cockpit/harness.js';
test("item detail merges API facts and moves in one responsive timeline [B33,B29]", { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for item-thread rendering checks.');

  const box = machine();
  const alpha = project(box, 'item-thread');
  await box.inProcess(alpha.repo, 'add', 'web', 'Thread fixture', '--specs', 'G1', '--criterion', 'The item keeps its evidence.');
  await box.inProcess(alpha.web, 'claim', '1');
  const sourceHead = box.git(alpha.repo, 'rev-parse', 'HEAD');
  /** Append a real board fact and return the identity the correction must name. */
  const addFact = async (kind, text, ...flags) => JSON.parse(await box.inProcess(alpha.web, 'fact', '1', kind, text, ...flags, '--json')).fact;
  const oldNote = await addFact('note', 'Earlier observation, now replaced.');
  await addFact('capture', 'Captured the rendered page.', '--ref', `SPEC.md:1-2@${sourceHead}`);
  await box.inProcess(alpha.web, 'release', '1', '--reason', 'OTHER', '--note', 'The item detail fixture releases its claim before opening the thread.');
  await addFact('measurement', 'The view settles in 8 seconds.');
  await box.inProcess(alpha.web, 'claim', '1');
  await addFact('diff', 'The detail gained a thread.');
  await addFact('decision', 'Keep the thread in the item.');
  await addFact('rejection', 'The first layout wrapped poorly.');
  const replacement = await addFact('supersession', 'Correction: the note is replaced.', '--supersedes', oldNote.id);
  await addFact('root-cause', 'The missing projection hid the facts.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-item-thread-chrome-'));
  let chrome;
  try {
    const apiState = await boardOf(view, alpha.repo);
    const expected = apiState.items.find((item) => item.id === 1).thread;
    // The board's own notes (the claim's policy re-freeze, add's duplicate-check ruling) are not facts this fixture appends.
    assert.deepEqual(expected.filter((entry) => entry.type === 'fact' && !/^(policy re-frozen automatically:|Not a duplicate of #)/u.test(entry.text)).map((entry) => entry.kind),
      ['note', 'capture', 'measurement', 'diff', 'decision', 'rejection', 'supersession', 'root-cause'],
      'the API provides every fact in append order');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('typeof data !== "undefined" && !!data?.project?.items?.find((item) => item.id === 1)');
    // The fact rows render with the thread; the exact event identities are asserted below, where a miss names the ids.
    await chrome.waitFor('document.querySelectorAll("#detail .tl .tl-fact").length === ' + expected.filter((entry) => entry.type === 'fact').length);
    await chrome.stable("(() => { const more = document.querySelector('#detail [data-item-panel-history]'); if (more && more.getAttribute('aria-expanded') !== 'true') more.click(); return true; })()");
    // The history folds to its newest five rows; the earlier note and the capture sit past the fold until the list is opened.
    await chrome.waitFor("document.querySelector('#detail .item-panel-history-list').classList.contains('expanded')");
    const expectedIds = expected.map((entry) => entry.eventId);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#detail .tl')?.getBoundingClientRect().width > 0`);
      const rendered = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const timeline = document.querySelector('#detail .tl');
        const old = document.querySelector('#detail #fact-${oldNote.id}');
        const replacement = document.querySelector('#detail #fact-${replacement.id}');
        const live = document.querySelector('#detail #fact-${expected.find((entry) => entry.type === 'fact' && entry.kind === 'capture').id}');
        const plain = document.querySelector('#detail .tl-fact:not(.tl-judgement):not(.tl-superseded)');
        const judgementColors = Object.fromEntries(['decision', 'rejection', 'supersession', 'root-cause'].map((kind) => {
          const row = [...timeline.querySelectorAll('.tl-fact')].find((entry) => entry.querySelector('.tl-kind')?.textContent === kind.replaceAll('-', ' '));
          return [kind, row ? getComputedStyle(row.querySelector('.tl-marker')).backgroundColor : null];
        }));
        return {
          ids: [...timeline.querySelectorAll('[data-event-id]')].map((row) => Number(row.dataset.eventId)),
          eventIds: [...timeline.querySelectorAll('[data-event-ids]')].flatMap(row => row.dataset.eventIds.split(' ').map(Number)),
          rows: timeline.querySelectorAll('li').length,
          kinds: [...timeline.querySelectorAll('.tl-fact .tl-kind')].map((chip) => chip.textContent),
          authors: [...timeline.querySelectorAll('.tl-fact .tl-who')].map((name) => name.textContent),
          ages: timeline.querySelectorAll('.tl-fact small time[data-ago]').length,
          oldClass: old?.className,
          replacementHref: old?.querySelector('.thread-replacement')?.getAttribute('href'),
          oldOpacity: Number(old && getComputedStyle(old).opacity),
          replacementOpacity: Number(replacement && getComputedStyle(replacement).opacity),
          liveOpacity: Number(live && getComputedStyle(live).opacity),
          plainMarker: plain ? getComputedStyle(plain.querySelector('.tl-marker')).backgroundColor : null,
          judgementColors,
          judgementKinds: Object.keys(judgementColors).filter((kind) => judgementColors[kind] !== null),
          ref: timeline.querySelector('.tl-fact button[data-code]')?.dataset.code,
          viewport: document.documentElement.clientWidth,
          pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        };
      })())`));
      assert.deepEqual(rendered.eventIds.toSorted((a, b) => a - b), expectedIds, `${width}px: every rendered row retains its exact API event identities`);
      assert.ok(rendered.ids[0] > rendered.ids.at(-1), `${width}px: history is shown newest first`);
      assert.equal(rendered.eventIds.length, expected.length, `${width}px: each API event appears exactly once, folded moves included`);
      assert.ok(rendered.rows <= expected.length && rendered.rows === rendered.ids.length, `${width}px: each row carries its event ids`);
      const expectedFacts = expected.filter((entry) => entry.type === 'fact');
      assert.deepEqual(rendered.kinds, expectedFacts.toReversed().map((entry) => entry.kind.replaceAll('-', ' ')), `${width}px: every native fact kind has its readable visible chip`);
      assert.deepEqual(rendered.authors, expectedFacts.toReversed().map((entry) => entry.by), `${width}px: each fact names its API author`);
      assert.equal(rendered.ages, expectedFacts.length, `${width}px: each fact shows its age`);
      assert.match(rendered.oldClass, /tl-superseded/, `${width}px: the earlier fact is visibly dimmed`);
      assert.equal(rendered.replacementHref, `#fact-${replacement.id}`, `${width}px: the earlier fact links to its replacement`);
      assert.ok(rendered.oldOpacity < rendered.replacementOpacity && rendered.oldOpacity < rendered.liveOpacity,
        `${width}px: computed opacity dims the superseded fact`);
      assert.deepEqual(rendered.judgementKinds, ['decision', 'rejection', 'supersession', 'root-cause'], `${width}px: all judgement kinds appear`);
      for (const [kind, color] of Object.entries(rendered.judgementColors)) {
        assert.notEqual(color, rendered.plainMarker, `${width}px: ${kind} uses a distinct computed marker color`);
      }
      assert.equal(rendered.ref, `SPEC.md:1-2@${sourceHead}`, `${width}px: the committed code reference is actionable`);
      assert.equal(rendered.pageWidth, rendered.viewport, `${width}px: the timeline causes no sideways page scroll`);
    }
    const scrollBefore = JSON.parse(await chrome.stable(`JSON.stringify({ page: document.documentElement.scrollTop, detail: document.querySelector('#detail').scrollTop })`));
    await chrome.click(`document.querySelector('#detail #fact-${oldNote.id} .thread-replacement')`);
    await chrome.waitFor(`location.hash === '#fact-${replacement.id}' && document.querySelector('#detail #fact-${replacement.id}')`);
    const target = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const detail = document.querySelector('#detail'), fact = document.querySelector('#detail #fact-${replacement.id}');
      const box = fact.getBoundingClientRect(), panel = detail.getBoundingClientRect();
      return { item: view.item, id: fact.id, text: document.querySelector('#detail h2')?.textContent,
        page: document.documentElement.scrollTop, detail: detail.scrollTop,
        visible: box.top >= panel.top && box.bottom <= panel.bottom };
    })())`));
    assert.equal(target.id, `fact-${replacement.id}`, 'the replacement anchor resolves to a visible fact');
    assert.equal(target.item, 1, 'following the link keeps the same item selected');
    assert.equal(target.text, '#1Thread fixture', 'the item detail stays open after following the replacement link');
    assert.ok(target.page > scrollBefore.page || target.detail > scrollBefore.detail,
      'following the replacement anchor scrolls to its existing target');
    assert.equal(target.visible, true, 'the replacement is visible after following its link');
    await chrome.click(`document.querySelector('#detail .tl-fact button[data-code]')`);
    await chrome.waitFor(`document.querySelector('#detail .tl-fact button[data-code]')?.getAttribute('aria-expanded') === 'true'`);
    await chrome.waitFor(`document.querySelector('#detail .tl-fact .code')?.textContent.includes('Demo spec')`);
    assert.match(await chrome.stable(`document.querySelector('#detail .tl-fact .code')?.textContent || ''`), /Demo spec/, 'the code reference opens the committed lines');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});


test('list rows hold their shape: one-line titles end in an ellipsis, every row as tall as the next [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for list row checks.');

  const box = machine();
  const demo = project(box, 'row-shape');
  const long = 'A title far too long for one line of the list: it names `pullboard land` and #1, then keeps on going past every width a phone or a laptop gives a row, so only an ellipsis can end it';
  const titles = { 1: 'Short title', 2: long, 3: 'Waits on the short one', 4: 'Built, then sent back with a long reason', 5: 'Being built right now' };
  await box.inProcess(demo.repo, 'add', 'web', titles[1], '--specs', 'G1', '--criterion', 'short');
  await box.inProcess(demo.repo, 'add', 'web', titles[2], '--specs', 'G1', '--criterion', 'long');
  await box.inProcess(demo.repo, 'add', 'web', titles[3], '--specs', 'G1', '--criterion', 'gated', '--after', '1', '--not-duplicate-of', '1 a different row');
  await box.inProcess(demo.repo, 'add', 'web', titles[4], '--specs', 'G1', '--criterion', 'back', '--not-duplicate-of', '1 a different row');
  await box.inProcess(demo.repo, 'add', 'web', titles[5], '--specs', 'G1', '--criterion', 'busy', '--not-duplicate-of', '1 a different row');
  build(box, demo, 4, 'four.txt');
  sendBack(box, demo, 4, `It misses the edge: ${'the criterion names a blank name and the page still greets it, '.repeat(4)}`);
  await box.inProcess(demo.web, 'claim', '5');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-row-shape-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 5');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const rows = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#chain .row')].map((row) => {
        const box = (node) => node.getBoundingClientRect();
        const lines = (node) => Math.round(box(node).height / parseFloat(getComputedStyle(node).lineHeight));
        const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
        const title = row.querySelector('.t'), meta = row.querySelector('.meta'), chip = row.querySelector('.row-side .item-stage');
        return { id: row.dataset.item, tip: row.title, height: Math.round(box(row).height),
          titleLines: lines(title), ellipsis: getComputedStyle(title).textOverflow === 'ellipsis' && getComputedStyle(title).whiteSpace === 'nowrap',
          cut: title.scrollWidth > title.clientWidth, metaLines: lines(meta), stage: chip.querySelector('.stage-word')?.textContent.trim() || chip.getAttribute('aria-label').split(': ')[0], detail: chip.querySelector('.stage-detail').textContent.trim(),
          chipHeight: Math.round(box(chip).height), chipClear: apart(box(chip), box(meta)) && apart(box(chip), box(title)),
          code: [...title.querySelectorAll('code')].map((code) => getComputedStyle(code).display) };
      }))`));
      const place = (row) => `${width}, #${row.id}: ${JSON.stringify(row)}`;
      assert.deepEqual(rows.map((row) => row.id).sort(), ['1', '2', '3', '4', '5'], `${width}: every item has a row`);
      for (const row of rows) {
        assert.equal(row.tip, titles[row.id], `${width}: the row's tooltip is its whole title`);
        assert.ok(row.titleLines === 1 && row.ellipsis, `title is one line, set to end in an ellipsis at ${place(row)}`);
        assert.equal(row.metaLines, 1, `the meta line never wraps, a long verdict reason included, at ${place(row)}`);
        assert.ok(row.chipHeight < 40 && row.chipClear, `the stage and detail stay together without overlapping title or metadata at ${place(row)}`);
      }
      assert.ok(rows.find((row) => row.id === '2').cut, `${width}: the long title is cut, so its ellipsis shows`);
      assert.deepEqual(rows.find((row) => row.id === '2').code, ['inline'], `${width}: inline code in a title stays a word in the line, not a block`);
      assert.equal(new Set(rows.map((row) => row.height)).size, 1, `${width}: every row is as tall as the next: ${JSON.stringify(rows.map((row) => [row.id, row.height]))}`);
      assert.equal(new Set(rows.map((row) => row.chipHeight)).size, 1, `${width}: every chip is the same size`);
      const chips = Object.fromEntries(rows.map((row) => [row.id, `${row.stage}: ${row.detail}`]));
      assert.deepEqual([chips[1], chips[2], chips[3], chips[4]], ['Ready: strong route', 'Ready: strong route', 'Blocked: by #1', 'Ready: strong route'], `${width}: each item's stage and short detail`);
      assert.match(chips[5], /^Building: by web-\d+ \(Test Model\)$/, `${width}: a claimed item names who builds it below the stage`);
      // The same state wears the same chip in the item's detail as in its row.
      for (const row of rows) {
        await chrome.click(`document.querySelector('#chain .row[data-item="${row.id}"]')`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.startsWith('#${row.id}')`);
        // A chip's colour eases in on the row just opened; read the paint once the transitions have settled.
        await chrome.waitFor("document.getAnimations().every((animation) => animation.playState !== 'running')");
        // The approved panel's chip names the stage only; the row keeps the detail and the seat.
        const detail = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const chip = document.querySelector('#detail .item-panel-head .ip-chip'), listed = document.querySelector('#chain .row[data-item="${row.id}"] .row-side .item-stage');
          const seat = listed.querySelector('.item-seat');
          return { chip: chip.textContent.trim(), seat: seat?.textContent.trim(), seatStage: seat?.getAttribute('aria-label'), seatVisible: seat ? seat.getClientRects().length > 0 : false };
        })())`));
        if (detail.seat) {
          assert.ok(detail.seatVisible && detail.seatStage.startsWith(row.stage + ': '), `${width}: ruling 49037 keeps the visible seat and accessible stage: ${JSON.stringify(detail)}`);
        }
        assert.equal(detail.chip, chips[row.id].split(':')[0].replace('Merged', 'Landed'), `${width}: #${row.id}'s detail names the stage its row names`);
      }
    }
    // Ruling 49037: a long model stays in the hover; the visible native seat remains whole.
    // Keep the long name in the real fixture so a live refresh cannot replace it between widths.
    const configPath = join(demo.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.agents = { names: 'prefix' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    // The fixture's own worktree is already joined, so a second worktree takes the long-model seat and the build of #5.
    const longSeat = join(box.dir, 'row-shape-long');
    box.git(demo.repo, 'worktree', 'add', '-q', longSeat, '-b', 'web/rowshapelong');
    await box.inProcess(longSeat, 'join', 'web', '--model', 'claude-opus-designer-on-a-long-review-model-name');
    await box.inProcess(demo.web, 'release', '5', '--reason', 'OTHER', '--note', 'The long-model seat takes over the build.');
    await box.inProcess(longSeat, 'claim', '5');
    await chrome.stable('refresh()');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain .row[data-item="5"] .stage-detail')?.textContent.startsWith('by claude-opus')`);
      const named = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const row = document.querySelector('#chain .row[data-item="5"]'), chip = row.querySelector('.row-side .item-seat'), meta = row.querySelector('.meta');
        const a = chip.getBoundingClientRect(), b = meta.getBoundingClientRect();
        return { seat: chip.textContent.trim(), hover: chip.title, chipWidth: a.width, cap: 10 * parseFloat(getComputedStyle(document.documentElement).fontSize), cut: chip.scrollWidth > chip.clientWidth,
          ellipsis: getComputedStyle(chip).textOverflow === 'ellipsis', clear: b.right <= a.left + 0.5, heights: [...new Set([...document.querySelectorAll('#chain .row')].map((r) => Math.round(r.getBoundingClientRect().height)))] };
      })())`));
      assert.ok(/^web-\d+$/u.test(named.seat) && !named.cut && named.hover.includes('claude-opus-designer-on-a-long-review-model-name') && named.hover.includes('Building:'), `${width}: the native seat stays whole and the long model and stage are available on hover: ${JSON.stringify(named)}`);
      assert.ok(named.clear && named.heights.length === 1, `${width}: and the row keeps its meta clear and its height: ${JSON.stringify(named)}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
