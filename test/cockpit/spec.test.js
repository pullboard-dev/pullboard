/** Cockpit spec checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { tapTarget, SPEC, machine, project, startView, styleOf, openPage, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, watchSpecDecisionWait, press } from './fixture.js';


test('spec rows read across a phone [N26,D1]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC, { practice: 'DOCTRINE.md' });
  // Its own house rules follow the doctrine file named by this repo's config.
  writeFileSync(join(alpha.repo, loadConfig(alpha.repo).practice), '# Practice\n\n## W · Writing\n- W1 [approved, must] Numbers over adjectives. No hedges, no filler. | gate: review\n- W2 [draft, aim] One record per decision. | gate: review\n');
  const view = await startView(box);
  try {
    const page = await openPage(view, { width: 375 });
    const doctrineRows = page.show('doctrine-list');
    assert.match(doctrineRows, /data-row="doctrine:W1"[^]*?Numbers over adjectives\./, 'W1 from the configured doctrine is shown');
    assert.match(doctrineRows, /data-row="doctrine:W2"[^]*?One record per decision\./, 'W2 from the configured doctrine is shown');
    const style = await styleOf(view);
    assert.match(style, /\n\.srow \{ display: grid; grid-template-columns: 3\.4em minmax\(0, 1fr\);/, 'a row is its id in a slim gutter and its text at full width, with no decision in it');
    const phone = /\n@media ([^{]+) \{ \.srow \{ grid-template-columns: 3em minmax\(0, 1fr\); gap: 8px; \} \}/.exec(style);
    assert.ok(phone, 'on a phone the gutter narrows and the text keeps the rest');
    assert.equal(phone[1], '(width < 480px)', 'under 480px only');

    // The rule holds because every row is the id, then its words, a chip first only where its status is not the filter's.
    await page.click({ rows: 'spec:all' });
    const rows = (html) => html.split('<div class="srow').slice(1);
    const shape = /^[^>]*><code>[^<]+<\/code><span class="srow-text">(?:<span class="chip[^"]*">[^<]+<\/span>)?[^<]+<\/span><\/div>/;
    assert.deepEqual(rows(page.show('spec-list')).map((row) => /data-row="spec:([^"]+)"/.exec(row)[1]), ['G1', 'G2']);
    for (const row of rows(page.show('spec-list'))) assert.match(row, shape);
    const doctrineShape = /^[^>]*><code>[^<]+<\/code><span class="srow-text">(?:<span class="chip[^"]*">[^<]+<\/span>)?(?:<small class="rule-source" title="[^"]+">(?:From Pullboard|This repo)<\/small>)?[^<]+<\/span><\/div>/;
    for (const row of rows(page.show('doctrine-list'))) assert.match(row, doctrineShape, "a rule is its id and its words, its source only where it differs from its section's, in the same two columns");
    assert.ok(rows(page.show('doctrine-list')).length > 0, 'doctrine rows are drawn the same way');
  } finally {
    await view.stop();
  }
});

test('Spec and Doctrine line up, open on a row and decide with quiet controls [N26, B26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec layout checks.');

  const spec = '# Demo spec\n\n## G · Goals\n- G1 [draft, must] One short line. | gate: web test\n- G2 [draft, must] A second draft row. | gate: web test\n- G3 [approved, must] An approved row. | gate: web test\n';
  const box = machine();
  project(box, 'spec-layout', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-layout-chrome-'));
  let chrome;
  /** Where the list and detail cards start, what is picked, and how a row's decision sits beside its text. */
  const read = async (kind) => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const pane = document.querySelector('[data-pane="${kind}"]');
    const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
    const row = document.querySelector('#${kind}-list .srow[data-row="${kind}:G1"]');
    const text = row?.querySelector('.srow-text');
    const buttons = row ? [...row.querySelectorAll('[data-row-decision]')] : [];
    const quiet = (e) => { const s = getComputedStyle(e); return s.borderTopWidth === '0px' && s.backgroundColor === 'rgba(0, 0, 0, 0)'; };
    const line = text ? parseFloat(getComputedStyle(text).lineHeight) : 0;
    return { list: box(pane.querySelector('.rows-card')), detail: box(pane.querySelector('.detail')), picked: document.querySelector('#${kind}-list .srow.on')?.dataset.row ?? null,
      shown: document.querySelector('#${kind}-detail h2 span')?.textContent ?? null, first: document.querySelector('#${kind}-list .srow')?.dataset.row ?? null,
      row: row && box(row), text: text && box(text), line, buttons: buttons.map((e) => ({ ...box(e), quiet: quiet(e), word: e.textContent })),
      decide: [...document.querySelectorAll('#${kind}-detail [data-row-decision]')].map((e) => ({ ...box(e), quiet: quiet(e), word: e.textContent })),
      section: [...document.querySelectorAll('#${kind}-list [data-section-approve], #${kind}-detail [data-row-decision]')].map((e) => quiet(e)),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.evaluate("document.querySelector('[data-tab=spec]').click(); document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').click(); view.row.spec = null; render();");
      await chrome.waitFor(`innerWidth === ${width} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
      const spec = await read('spec');
      if (width === 1280) assert.ok(Math.abs(spec.list.top - spec.detail.top) < 0.5, `${width}: the list and the detail start on one line: ${JSON.stringify([spec.list, spec.detail])}`);
      assert.deepEqual([spec.picked, spec.shown], ['spec:G1', 'G1'], `${width}: with nothing picked, the detail opens on the first row shown`);
      assert.deepEqual([spec.buttons.length, spec.decide.map((b) => b.word)], [0, ['Approve', 'Decline']], `${width}: a row carries no decision; the picked row's detail holds it once`);
      assert.ok(spec.decide.every((b) => b.quiet && b.height >= tapTarget(width)), `${width}: quiet words, no box or fill until hovered, each a target: ${JSON.stringify(spec.decide)}`);
      assert.ok(spec.section.length >= 3 && spec.section.every(Boolean), `${width}: Approve all and the detail's decision are quiet too`);
      if (width === 1280) {
        assert.ok(spec.row.height <= 60 && Math.round(spec.text.height / spec.line) <= 2, `${width}: a one-sentence row takes one or two lines: ${JSON.stringify([spec.row, spec.text, spec.line])}`);
      }
      assert.ok(!spec.overflow, `${width}: nothing runs off the screen`);
      // A filter that hides the pick moves it to the new first row; one that keeps it keeps it.
      await chrome.evaluate("document.querySelector('#spec-list [data-row=\"spec:G2\"]').click()");
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:all\"]').click()");
      assert.equal((await read('spec')).picked, 'spec:G2', `${width}: a filter that still shows the pick keeps it`);
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:approved\"]').click()");
      const moved = await read('spec');
      assert.deepEqual([moved.picked, moved.shown], ['spec:G3', 'G3'], `${width}: a filter that hides the pick moves it to the first row shown`);
      await chrome.evaluate("document.querySelector('[data-tab=doctrine]').click(); view.row.doctrine = null; render();");
      const doctrine = await read('doctrine');
      if (width === 1280) assert.ok(Math.abs(doctrine.list.top - doctrine.detail.top) < 0.5, `${width}: Doctrine's cards start on one line too`);
      assert.ok(doctrine.picked && doctrine.picked === doctrine.first && doctrine.shown === doctrine.first.split(':')[1], `${width}: and Doctrine opens on its first row: ${JSON.stringify([doctrine.picked, doctrine.shown])}`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('spec rows read as a list, decided in the panel [N26]', { timeout: 300_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec list checks.');

  // Each of the four layouts decides two rows on each tab, one approved and one declined, so each tab has eight drafts.
  const drafts = (prefix, from, words) => words.map((w, n) => `- ${prefix}${from + n} [draft, must] ${w} | gate: review\n`).join('');
  const eight = ['The page names its owner.', 'Every list says when it was read.', 'A failed save says why.', 'Dates say which day they were.',
    'Long titles end in an ellipsis.', 'The theme follows the system.', 'Each tab keeps its place.', 'Empty lists say how to start.'];
  const spec = '# Decisions\n\n## S · Screens\n'
    + '- S1 [draft, must] The board loads in under a second. | gate: web test\n'
    + '- S2 [pending] Should the board remember the last tab? | gate: review\n'
    + '- S3 [approved, must] Pages never scroll sideways. | gate: web test\n'
    + drafts('S', 4, eight);
  const box = machine();
  const demo = project(box, 'spec-list', spec, { practice: 'ways.md' });
  // Rules this repo wrote, as drafts: the person decides them as Spec rows are decided. Pullboard's own rules come too.
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n' + drafts('D', 1, eight));
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-list-chrome-'));
  let chrome;
  /** One tab's rows and detail as they read: each row's chip, gutter, words and lines, and the detail's decision. */
  const read = async (kind) => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const rows = [...document.querySelectorAll('#${kind}-list .srow')].map((row) => {
      const s = getComputedStyle(row), text = row.querySelector('.srow-text');
      return { id: row.dataset.row.slice(${kind.length + 1}), chip: row.querySelector('.chip')?.textContent ?? null, gutter: box(row.querySelector('code')), text: box(text), row: box(row),
        lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)), buttons: row.querySelectorAll('button').length,
        on: row.classList.contains('on'), tint: s.backgroundColor, edges: [s.borderLeftWidth, s.borderLeftColor].join() === [s.borderRightWidth, s.borderRightColor].join() };
    });
    const detail = document.querySelector('#${kind}-detail');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      rows, picked: view.row['${kind}'], shown: detail.querySelector('h2 span')?.textContent ?? null, viewport: innerHeight,
      decide: [...detail.querySelectorAll('[data-row-decision]')].map((b) => ({ word: b.textContent, ...box(b) })),
      section: [...document.querySelectorAll('#${kind}-list [data-section-approve]')].map((b) => ({ word: b.textContent, height: b.getBoundingClientRect().height, head: !!b.closest('.spec-section-head') })),
    };
  })())`));
  /** A tint is quiet when its colour channels sit close together: grey, not a hue. */
  const neutral = (css) => { const [r, g, b] = (css.match(/[\d.]+/g) || []).map(Number); return Math.max(r, g, b) - Math.min(r, g, b) <= 12; };
  /** Press a key the way a keyboard does, into whatever has focus. */
  const press = async (key, code, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && key.length === 1 ? { text: key, unmodifiedText: key } : {}) });
  };
  /** Tap an element through Chrome's input path at its centre. */
  const tap = async (selector) => {
    const point = JSON.parse(await chrome.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    for (const type of ['mousePressed', 'mouseReleased']) await chrome.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  const filter = async (kind, name) => {
    await chrome.evaluate(`document.querySelector('[data-tab=${kind}]').click(); document.querySelector('#${kind}-chips [data-rows="${kind}:${name}"]').click()`);
    await chrome.waitFor(`!document.querySelector('[data-pane=${kind}]').hidden && !!document.querySelector('#${kind}-list .srow')`);
  };
  /** A row as the board records it: Spec rows by id, Doctrine rules by id among the merged rules. */
  const recorded = async (kind, id) => {
    const state = await boardOf(view, demo.repo);
    const row = (kind === 'spec' ? state.spec : state.practice).find((entry) => entry.id === id);
    // An undecided row has no stage of its own, only its status; an approval carries no reason.
    return { stage: row?.stage || row?.status || null, decided: row?.decision ? (row.decision.reason || 'approved') : null };
  };
  const expected = { spec: { decide: [['S1', null], ['S2', 'pending'], ...eight.map((_, n) => [`S${n + 4}`, null])] }, doctrine: { decide: eight.map((_, n) => [`D${n + 1}`, null]) } };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project?.spec?.length && data.project.practice.some((r) => r.id === 'D8')");
    // Pullboard's own rules can wait on the person too; they list under Needs your decision, in the board's order, but are
    // changed in DOCTRINE.md rather than decided here.
    const order = JSON.parse(await chrome.evaluate("JSON.stringify(data.project.practice.map((r) => [r.id, r.origin, r.status, !!r.decision]))"));
    const standardWaiting = order.filter(([, origin, status, decided]) => origin === 'standard' && ['pending', 'draft'].includes(status) && !decided).map(([id, , status]) => [id, status === 'draft' ? null : status]);
    expected.doctrine.decide = [...standardWaiting, ...expected.doctrine.decide].sort(([a], [b]) => order.findIndex(([id]) => id === a) - order.findIndex(([id]) => id === b));
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        for (const kind of ['spec', 'doctrine']) {
          const tab = `${at} ${kind}`;
          await filter(kind, 'decide');
          let r = await read(kind);
          assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${tab}: no sideways scroll`);
          // Each row is its id in a slim gutter and its words at full width; a chip only where the status is not the filter's.
          const undecidedNow = expected[kind].decide;
          assert.deepEqual(r.rows.map((row) => [row.id, row.chip, row.buttons]), undecidedNow.map(([id, chip]) => [id, chip, 0]),
            `${tab}: drafts carry no chip under Needs your decision, an open question says pending, and no row carries a decision`);
          for (const row of r.rows) {
            assert.ok(row.gutter.width <= 52 && row.text.left - row.gutter.right <= 14 && row.row.right - row.text.right <= 12, `${tab}: ${row.id} is a slim gutter and full-width words: ${JSON.stringify(row)}`);
            if (width === 1280) assert.ok(row.lines <= 2, `${tab}: ${row.id}, one sentence, takes one or two lines: ${row.lines}`);
          }
          const picked = r.rows.find((row) => row.on);
          assert.ok(picked && neutral(picked.tint) && picked.edges, `${tab}: the picked row is a quiet neutral tint with no coloured edge: ${JSON.stringify(picked)}`);
          // On Spec, Approve all stays on the section's header.
          if (kind === 'spec') assert.deepEqual(r.section.map((b) => [b.word, b.head, b.height >= tapTarget(width)]), [[`Approve all ${undecidedNow.length} in this section`, true, true]], `${tab}: Approve all stays on the section header`);
          else assert.deepEqual(r.section, [], `${tab}: Doctrine rules are decided one at a time`);

          // With focus in the list the arrows move the pick, A approves and moves on, and D asks why, then records it.
          const [first, second, third] = undecidedNow.filter(([, chip]) => chip === null).map(([id]) => id);
          await tap(`#${kind}-list [data-row="${kind}:${first}"]`);
          await chrome.waitFor(`view.row['${kind}'] === '${first}' && document.activeElement === document.querySelector('#${kind}-list')`);
          // At 375 the detail stacks under the list: tapping a row brings its decision into view.
          if (width === 375) await chrome.waitFor(`(() => { const d = document.querySelector('#${kind}-detail [data-row-decision="approve"]')?.getBoundingClientRect(); return !!d && d.top >= 0 && d.bottom <= innerHeight; })()`, 10_000);
          // The picked row's detail holds its decision once, a 44px target each.
          const held = await read(kind);
          assert.deepEqual(held.decide.map((b) => b.word), ['Approve', 'Decline'], `${tab}: the picked row's detail holds its decision`);
          assert.ok(held.decide.every((b) => b.height >= tapTarget(width)), `${tab}: each a target, 44px where a finger taps`);
          await press('ArrowDown', 'ArrowDown', 40);
          assert.equal(await chrome.evaluate(`view.row['${kind}']`), undecidedNow[undecidedNow.findIndex(([id]) => id === first) + 1][0], `${tab}: down moves the pick`);
          await press('ArrowUp', 'ArrowUp', 38);
          assert.equal(await chrome.evaluate(`view.row['${kind}']`), first, `${tab}: and up moves it back`);
          await press('a', 'KeyA', 65);
          const after = undecidedNow[undecidedNow.findIndex(([id]) => id === first) + 1][0];
          await chrome.waitFor(`!!document.querySelector('#${kind}-list .spec-feedback.ok') && view.row['${kind}'] === '${after}'`, 15_000);
          assert.deepEqual([await recorded(kind, first), await recorded(kind, second)], [{ stage: 'approved, pending apply', decided: 'approved' }, { stage: 'draft', decided: null }],
            `${tab}: A approved the picked ${first}, and only ${first}`);
          assert.equal(await chrome.evaluate(`document.activeElement === document.querySelector('#${kind}-list')`), true, `${tab}: the list keeps focus for the next key`);
          // The pick moved on to the next row; when that is the open question, step past it to a draft.
          if (after !== second) { await press('ArrowDown', 'ArrowDown', 40); await chrome.waitFor(`view.row['${kind}'] === '${second}'`); }
          await press('d', 'KeyD', 68);
          await chrome.waitFor(`!document.querySelector('#spec-decline-dialog').hidden && document.querySelector('#spec-decline-title').textContent === 'Decline ${second}'`);
          // Never while typing in a field: an a in the reason is a letter, not an approval.
          await press('a', 'KeyA', 65);
          assert.equal(await chrome.evaluate("document.querySelector('#spec-decline-reason').value"), 'a', `${tab}: the key types into the reason`);
          assert.deepEqual(await recorded(kind, second), { stage: 'draft', decided: null }, `${tab}: and decides nothing`);
          await chrome.send('Input.insertText', { text: ' clearer outcome, please' });
          await chrome.evaluate("document.querySelector('#spec-decline-submit').click()");
          await chrome.waitFor(`document.querySelector('#spec-decline-dialog').hidden && !!document.querySelector('#${kind}-list .spec-feedback.ok')`, 15_000);
          assert.deepEqual(await recorded(kind, second), { stage: 'declined, pending apply', decided: 'a clearer outcome, please' }, `${tab}: D declined ${second} with its reason`);
          // The last layout decides the last two drafts, so only the earlier ones have a row after them to stay untouched.
          if (third) assert.deepEqual(await recorded(kind, third), { stage: 'draft', decided: null }, `${tab}: and nothing else`);
          assert.equal(await chrome.evaluate(`document.activeElement === document.querySelector('#${kind}-list')`), true, `${tab}: the dialog returns to the list`);
          // The two decided rows leave Needs your decision.
          expected[kind].decide = undecidedNow.filter(([id]) => id !== first && id !== second);
          await chrome.waitFor(`![...document.querySelectorAll('#${kind}-list .srow')].some((row) => ['${kind}:${first}', '${kind}:${second}'].includes(row.dataset.row))`, 15_000);

          // Under All rows, every row not approved says what it is.
          await filter(kind, 'all');
          r = await read(kind);
          const all = Object.fromEntries(r.rows.map((row) => [row.id, row.chip]));
          assert.deepEqual([all[first], all[second]], ['approved, pending apply', 'declined, pending apply'], `${tab}: under All rows the decided rows say so`);
          if (kind === 'spec') assert.deepEqual([all.S2, all.S3], ['pending', null], `${tab}: the open question says pending; the approved row needs no chip`);
          else assert.ok(r.rows.some((row) => row.id.startsWith('PB') && row.chip === null), `${tab}: Pullboard's own approved rules need no chip`);
        }
      }
    }

    // A rule that comes with Pullboard is changed in DOCTRINE.md, not decided here: its detail offers no decision, and A does nothing.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');
    await filter('doctrine', 'all');
    const standard = await chrome.evaluate("[...document.querySelectorAll('#doctrine-list .srow')].map((row) => row.dataset.row.slice(9)).find((id) => id.startsWith('PB'))");
    await tap(`#doctrine-list [data-row="doctrine:${standard}"]`);
    await chrome.waitFor(`view.row.doctrine === '${standard}' && document.activeElement === document.querySelector('#doctrine-list')`);
    assert.equal(await chrome.evaluate("document.querySelectorAll('#doctrine-detail [data-row-decision]').length"), 0, `${standard}: a standard rule's detail offers no decision`);
    await press('a', 'KeyA', 65);
    assert.equal((await recorded('doctrine', standard)).decided, null, `${standard}: A decides nothing on it`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('real Chrome records Spec row decisions from the row, detail and confirmed section controls [B26,N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec decision checks.');

  /** Click a visible control through Chrome's input path without scrolling the result away. */
  const click = async (chrome, selector) => {
    const point = JSON.parse(await chrome.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) throw Error('missing ' + ${JSON.stringify(selector)});
      e.scrollIntoView({block:'center'});
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.top < 0 || r.bottom > innerHeight) throw Error('control is not visible: ' + ${JSON.stringify(selector)});
      return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
    })()`));
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };

  /** Run the full decision story in a fresh real board and browser at one viewport width. */
  const runWidth = async (width) => {
    const rows = Array.from({ length: 29 }, (_, index) => `- G${index + 1} [draft, must] Goal ${index + 1}. | gate: web test`);
    const spec = `# Decisions\n\n## G · Goals\n${rows.join('\n')}\n\n## K · Follow-up\n- K1 [draft, must] Follow-up one. | gate: web test\n- K2 [draft, must] Follow-up two. | gate: web test\n`;
    const box = machine();
    const demo = project(box, `spec-decisions-${width}`, spec);
    const view = await startView(box);
    const profile = mkdtempSync(join(tmpdir(), `pullboard-spec-decisions-${width}-`));
    let chrome;
    let diagnostics;
    try {
      chrome = await openSnapshotChrome(executable, view.link.href, profile);
      await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.evaluate("document.querySelector('[data-tab=spec]').click()");
      await chrome.waitFor(`innerWidth === ${width} && !!document.querySelector('#spec-list [data-row="spec:G1"]')`);
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:all\"]').click()");
      await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G2\"]') && document.querySelector('#spec-chips [data-rows=\"spec:decide\"] b')?.textContent === '31'");
      const geometry = JSON.parse(await chrome.evaluate(`JSON.stringify({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        controls: [...document.querySelectorAll('#spec-list button[data-row-decision],#spec-list button[data-section-approve]')].map(e=>({height:e.getBoundingClientRect().height})),
        rows: [...document.querySelectorAll('#spec-list .srow')].map(row=>{
          const chip=row.querySelector('.srow-text .chip');
          const words=[...(row.querySelector('.srow-text')?.childNodes||[])].find(n=>n.nodeType===3&&n.textContent.trim());
          if (!chip || !words) return {id:row.dataset.row, missing:true};
          const range=document.createRange(); range.selectNodeContents(words);
          const a=chip.getBoundingClientRect(), b=range.getClientRects()[0];
          return {id:row.dataset.row, intersects:a.right>b.left && a.left<b.right && a.bottom>b.top && a.top<b.bottom};
        })
      })`));
      assert.equal(geometry.overflow, false, `${width}: Spec has no horizontal overflow`);
      assert.deepEqual(geometry.controls.filter((control) => control.height < tapTarget(width)), [], `${width}: row and section controls meet the target`);
      assert.deepEqual(geometry.rows.filter((row) => row.missing), [], `${width}: row status and text are present for every fixture row`);
      if (width === 1280) assert.deepEqual(geometry.rows.filter((row) => row.intersects), [], '1280: stage chips never cover row text');

      await chrome.evaluate("document.querySelector('#spec-list [data-row=\"spec:G2\"]').click()");
      await chrome.waitFor("document.querySelector('#spec-detail h2 span')?.textContent === 'G2'");
      assert.ok(await chrome.evaluate("document.querySelector('#spec-detail [data-row-decision=approve]') && document.querySelector('#spec-detail [data-row-decision=decline]')"), `${width}: selected G2 has both detail decisions`);
      diagnostics = await watchSpecDecisionWait(chrome);
      // Picked from the list, A approves G1, and the pick moves on to the next row.
      await click(chrome, '#spec-list [data-row="spec:G1"]');
      const specFocusCondition = "view.row.spec === 'G1' && document.activeElement === document.querySelector('#spec-list')";
      await diagnostics.waitFor(specFocusCondition);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, ...(type === 'keyDown' ? { text: 'a', unmodifiedText: 'a' } : {}) });
      await chrome.waitFor("!!document.querySelector('#spec-list .spec-feedback.ok,#spec-list .spec-feedback.no')");
      let state = await boardOf(view, demo.repo);
      assert.equal(state.spec.find((row) => row.id === 'G1')?.stage, 'approved, pending apply', `${width}: A approves the picked G1`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision, undefined, `${width}: and nothing else`);
      await chrome.waitFor("view.row.spec === 'G2' && document.querySelector('#spec-detail h2 span')?.textContent === 'G2'");
      assert.ok(await chrome.evaluate(`(() => { const e=document.querySelector('#spec-list [data-row="spec:G2"]'); const r=e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), `${width}: next undecided G2 stays in the viewport after G1 approval`);
      assert.equal(await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:decide\"] b').textContent"), '30', `${width}: Needs your decision excludes the decided row`);
      if (width === 1280) assert.ok(await chrome.evaluate(`(() => {
        const row=document.querySelector('#spec-list [data-row="spec:G1"]');
        const chip=row.querySelector('.srow-text .chip').getBoundingClientRect();
        const words=[...row.querySelector('.srow-text').childNodes].find(n=>n.nodeType===3&&n.textContent.trim());
        const range=document.createRange(); range.selectNodeContents(words); const text=range.getClientRects()[0];
        return chip.right <= text.left || chip.bottom <= text.top || chip.top >= text.bottom;
      })()`), '1280: the approved pending stage does not cover row text');

      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').click()");
      assert.equal(await chrome.evaluate("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]')"), false, `${width}: approval immediately leaves Needs your decision`);
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:all\"]').click()");

      await click(chrome, '#spec-detail [data-row-decision="decline"]');
      assert.ok(await chrome.evaluate("!document.querySelector('#spec-decline-dialog').hidden && document.querySelector('#spec-decline-title').textContent === 'Decline G2'"), `${width}: G2 decline opens the reason form`);
      assert.ok(await chrome.evaluate(`[...document.querySelectorAll('#spec-decline-dialog input,#spec-decline-dialog button')].every(e => e.getBoundingClientRect().height >= ${tapTarget(width)})`), `${width}: decline reason and controls meet the 44px target`);
      await click(chrome, '#spec-decline-cancel');
      state = await boardOf(view, demo.repo);
      assert.equal(state.events.filter((event) => event.event_kind === 'row_decision').length, 1, `${width}: cancelling decline records no event`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision, undefined, `${width}: cancelling leaves G2 undecided`);

      await click(chrome, '#spec-detail [data-row-decision="decline"]');
      await chrome.evaluate("document.querySelector('#spec-decline-reason').value = 'Needs a clearer outcome'");
      box.run(demo.repo, 'shout', 'person', `refresh probe ${width}`);
      await chrome.waitFor(`data.project.shouts.some(shout => shout.shout_text === 'refresh probe ${width}')`);
      assert.equal(await chrome.evaluate("document.querySelector('#spec-decline-reason').value"), 'Needs a clearer outcome', `${width}: typed reason survives a live refresh`);
      await click(chrome, '#spec-decline-submit');
      await chrome.waitFor("!!document.querySelector('#spec-detail .spec-feedback.ok,#spec-detail .spec-feedback.no')");

      await chrome.evaluate("window.__sectionConfirm = null; window.confirm = message => { window.__sectionConfirm = message; return false; }");
      const sectionSelector = `#spec-list [data-section-approve]`;
      await chrome.evaluate(`(() => { const button=[...document.querySelectorAll(${JSON.stringify(sectionSelector)})].find(e=>e.parentElement.querySelector('h4')?.textContent.includes('Follow-up')); if(!button) throw Error('missing K section approval'); button.click(); })()`);
      state = await boardOf(view, demo.repo);
      assert.match(await chrome.evaluate('window.__sectionConfirm'), /Approve all 2 undecided rows in/, `${width}: section approval asks for confirmation`);
      assert.equal(await chrome.evaluate("!!document.querySelector('#spec-list .spec-feedback')"), false, `${width}: dismissing the confirmation starts no move`);
      assert.equal(state.events.filter((event) => event.event_kind === 'row_decision').length, 2, `${width}: dismissing section confirmation records no events`);
      assert.equal(state.spec.find((row) => row.id === 'K1')?.decision, undefined, `${width}: dismissed section approval leaves K1 undecided`);

      await chrome.evaluate("window.confirm = () => true");
      await chrome.evaluate(`(() => { const button=[...document.querySelectorAll(${JSON.stringify(sectionSelector)})].find(e=>e.parentElement.querySelector('h4')?.textContent.includes('Follow-up')); if(!button) throw Error('missing K section approval'); button.click(); })()`);
      await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:K1\"]').innerText.includes('approved, pending apply') && document.querySelector('#spec-list [data-row=\"spec:K2\"]').innerText.includes('approved, pending apply')");
      state = await boardOf(view, demo.repo);
      const decisions = state.events.filter((event) => event.event_kind === 'row_decision');
      assert.equal(decisions.length, 4, `${width}: approve, decline and two section rows produce four events`);
      assert.deepEqual(decisions.map((event) => event.event_by), ['person', 'person', 'person', 'person'], `${width}: every decision is recorded by the person`);
      assert.deepEqual(decisions.map((event) => JSON.parse(event.event_detail).channel), ['view', 'view', 'view', 'view'], `${width}: every decision uses the view channel`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.stage, 'declined, pending apply', `${width}: G2 shows its pending decline stage`);
      assert.equal(state.spec.find((row) => row.id === 'G2')?.decision?.reason, 'Needs a clearer outcome', `${width}: decline reason is in board state`);
      assert.equal(state.spec.find((row) => row.id === 'K1')?.stage, 'approved, pending apply', `${width}: K1 was approved`);
      assert.equal(state.spec.find((row) => row.id === 'K2')?.stage, 'approved, pending apply', `${width}: K2 was approved`);
      assert.equal(state.spec.find((row) => row.id === 'G3')?.decision, undefined, `${width}: other section rows remain undecided`);
      if (width === 1280) assert.ok(await chrome.evaluate(`['G1','G2','K1','K2'].every(id => {
        const row=document.querySelector('#spec-list [data-row="spec:'+id+'"]');
        const chip=row.querySelector('.srow-text .chip').getBoundingClientRect();
        const words=[...row.querySelector('.srow-text').childNodes].find(n=>n.nodeType===3&&n.textContent.trim());
        const range=document.createRange(); range.selectNodeContents(words); const text=range.getClientRects()[0];
        return chip.right <= text.left || chip.bottom <= text.top || chip.top >= text.bottom;
      })`), '1280: every pending decision stage has room beside its row text');
      await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').click()");
      await chrome.waitFor("document.querySelector('#spec-list [data-row=\"spec:G3\"]') && !document.querySelector('#spec-list [data-row=\"spec:G1\"]') && !document.querySelector('#spec-list [data-row=\"spec:G2\"]') && !document.querySelector('#spec-list [data-row=\"spec:K1\"]') && !document.querySelector('#spec-list [data-row=\"spec:K2\"]')");
      assert.ok(await chrome.evaluate("document.querySelector('#spec-chips [data-rows=\"spec:decide\"]').innerText.includes('27')"), `${width}: Needs your decision excludes all four decided rows`);
      assert.deepEqual(chrome.exceptions, [], `${width}: Chrome reports no uncaught exceptions`);
    } finally {
      try { await diagnostics?.dispose(); }
      finally {
        try { if (chrome) await closeSnapshotChrome(chrome); }
        finally {
          try { await view.stop(); }
          finally { rmSync(profile, { recursive: true, force: true }); }
        }
      }
    }
  };

  await runWidth(375);
  await runWidth(1280);
});

test('the spec decision wait names its state on timeout [N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec wait diagnostics.');

  const spec = '# Timeout probe\n\n## G · Goals\n- G1 [draft, must] First goal. | gate: web test\n- G2 [draft, must] Second goal. | gate: web test\n';
  const box = machine();
  const demo = project(box, 'spec-wait-timeout', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-timeout-'));
  let chrome;
  let diagnostics;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.evaluate("document.querySelector('[data-tab=spec]').click()");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]') && !!document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    diagnostics = await watchSpecDecisionWait(chrome);
    const point = JSON.parse(await chrome.evaluate(`(() => {
      const row=document.querySelector('#spec-list [data-row="spec:G1"]');
      row.scrollIntoView({block:'center'});
      const r=row.getBoundingClientRect();
      return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});
    })()`));
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await chrome.waitFor("view.row.spec === 'G1' && document.activeElement === document.querySelector('#spec-list')");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await chrome.waitFor("view.row.spec === 'G2'");

    let timeout;
    try { await diagnostics.waitFor('false', 10); } catch (error) { timeout = error; }
    assert.match(timeout?.message ?? '', /Browser condition did not arrive: false/, 'the test deliberately drives the real wait helper to timeout');
    assert.deepEqual(timeout.diagnostic.selectedRow, 'G2', 'the timeout record names the currently selected row');
    assert.equal(timeout.diagnostic.focusedElement.id, 'spec-list', 'the timeout record names the focused list');
    assert.ok(Array.isArray(timeout.diagnostic.pendingRequests), 'the timeout record includes bounded in-flight requests');
    assert.deepEqual(timeout.diagnostic.lastKeyEvents.slice(-2).map(({ type, key, code }) => [type, key, code]), [
      ['keydown', 'ArrowDown', 'ArrowDown'], ['keyup', 'ArrowDown', 'ArrowDown'],
    ], 'the timeout record includes the last real key events');
  } finally {
    try { await diagnostics?.dispose(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { rmSync(profile, { recursive: true, force: true }); }
        finally { await view.stop(); }
      }
    }
  }
});
