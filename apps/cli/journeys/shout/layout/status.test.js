// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/cost.css apps/view/src/io/doctrine.css apps/view/src/io/item/panel.css apps/view/src/io/item/rows.css */
/** @pullboard-test-gui */
/** Cockpit layout checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sendBackWithClause } from './send-back.js';
import { fileFixtureItem } from '../../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';
import {
  openShoutConversation,
  SPEC,
  machine,
  project,
  build,
  startView,
  element,
  settle,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../../tests/fixtures/cockpit/harness.js';


test('the status bar holds one line under no pointer [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for status bar media checks.');

  const box = machine();
  const demo = project(box, 'pointer-none');
  for (let index = 1; index <= 3; index += 1) {
    box.run(demo.repo, 'add', 'web', `Status item ${index}`, '--specs', 'G1', '--criterion', 'visible on the board');
  }
  box.run(demo.web, 'shout', 'coordinator', 'Which status label should we use?', '--kind', 'question');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-status-none-'));
  const wrapper = join(profile, 'chrome-pointer-none');
  const quotedExecutable = "'" + executable.replaceAll("'", "'\\''") + "'";
  writeFileSync(wrapper, '#!/bin/sh\nexec ' + quotedExecutable + ' --blink-settings=primaryPointerType=1,availablePointerTypes=1 "$@"\n');
  chmodSync(wrapper, 0o755);
  let chrome;
  try {
    chrome = await openSnapshotChrome(wrapper, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data && data.project?.items?.length === 3");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const layout = JSON.parse(await chrome.stable(`JSON.stringify({
      pointer: { none: matchMedia('(pointer: none)').matches, fine: matchMedia('(pointer: fine)').matches, coarse: matchMedia('(pointer: coarse)').matches },
      parts: [...document.querySelectorAll('.status [data-status]')].filter((button) => !button.hidden && button.getBoundingClientRect().width > 0).map((button) => {
        const rects = [...button.childNodes].flatMap((node) => {
          const range = document.createRange(); range.selectNodeContents(node);
          return [...range.getClientRects()].map((rect) => ({ top: rect.top, height: rect.height }));
        });
        const lineTops = [];
        for (const rect of rects) if (!lineTops.some((top) => Math.abs(top - rect.top) <= 2)) lineTops.push(rect.top);
        return { label: button.textContent.replace(/\\s+/g, ' ').trim(), height: button.getBoundingClientRect().height, minHeight: getComputedStyle(button).minHeight, rects, lineTops };
      })
    })`));
    console.log('375 pointer none raw layout', JSON.stringify(layout));
    assert.deepEqual(layout.pointer, { none: true, fine: false, coarse: false }, `wrapper produces real pointer:none CSS state: ${JSON.stringify(layout.pointer)}`);
    assert.ok(layout.parts.some((part) => part.label === '3 items'), `the real board's Items status part is present: ${JSON.stringify(layout.parts)}`);
    const audit = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return !e.disabled&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&!e.closest('[hidden]')};
      const selector='button,a[href],input:not([type=hidden]),select,textarea,[role=button],[data-root],[data-tab],[data-go],[data-item],[data-state],[data-rows],[data-row],[data-release],[data-shout],[data-new],[data-code]';
      const controls=[...new Set(document.querySelectorAll(selector))].filter(visible).map(e=>{const r=e.getBoundingClientRect();return {text:(e.innerText||e.getAttribute('aria-label')||'').trim(),height:r.height,inlineReference:e.matches('.feed button.ref, .feed a.ref[data-go], .shout button.ref, .shout a.ref[data-go], .shout .band a, .detail button.ref, .detail a.ref[data-go]')||!!e.closest('#chain .meta .gate, #detail .kv dd.waits-on'),statusBar:!!e.closest('.status')&&!matchMedia('(pointer: coarse)').matches,oneLine:!e.closest('.status')||getComputedStyle(e).whiteSpace==='nowrap'}});
      return {controls,tap:getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(),wrapped:controls.filter(c=>!c.oneLine)};
    })())`));
    assert.equal(audit.tap, '32px', `with no pointer at 1280 the targets are the compact ones a mouse gets; touch keeps 44px: ${JSON.stringify(audit.controls)}`);
    assert.deepEqual(audit.wrapped, [], `the demo's visible status labels stay on one line at 1280: ${JSON.stringify(audit.controls)}`);
    assert.deepEqual(layout.parts.filter((part) => part.lineTops.length !== 1), [], `each status part occupies one text line: ${JSON.stringify(layout.parts)}`);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the board reads at a glance from the status bar [N26]', { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for status bar checks.');

  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const spec = `${SPEC}- G3 [approved, must] The page has a footer. | gate: web test\n- G4 [approved, must] The page has a header. | gate: web test\n`;
  const alpha = project(box, 'glance', spec, { lanes });
  const add = (lane, title, ...more) => box.run(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'renders', ...more);
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Free', criterion: 'renders', args: ['--specs', 'G1,G2,G3,G4'], run: (root, ...argv) => ({ code: 0, out: box.run(root, ...argv) }) });
  add('web', 'Base');
  add('web', 'Depends', '--after', '2');
  add('api', 'Api work');
  add('web', 'Shipped');
  add('web', 'Bounced');
  add('web', 'Done');
  build(box, alpha, 5, 'shipped.html');
  build(box, alpha, 6, 'bounced.html');
  build(box, alpha, 7, 'done.html');
  sendBackWithClause(box, alpha, 6, 'the footer is missing\nand more on the next line', 'renders');
  accept(box, alpha, 7);
  box.run(alpha.web, 'claim', '2');
  box.run(alpha.repo, 'hold', 'api', '--reason', 'API freeze');
  box.run(alpha.repo, 'milestone', 'add', '1.0: first cut', '--note', 'The first pages', '--items', '1,5,7', '--reason', 'Arrange fixture release');
  box.run(alpha.repo, 'milestone', 'add', '2.0: the rest', '--note', 'After the first cut', '--items', '2,3,4', '--reason', 'Arrange fixture release');
  const second = join(box.dir, 'glance-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/glance2');
  joinFixtureSeat(box, second, 'web');
  box.run(second, 'shout', 'all', 'Free when you need me.');
  box.run(alpha.repo, 'shout', 'web', 'Pages first, then the footer.');
  box.run(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision', '--kind', 'question');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-glance-chrome-'));
  let chrome;
  /** The page as it reads: the header, the bar's parts, the list's rows and the toolbar, measured where they stand. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    /** Count the shared segmented control's actual hit extensions as part of its touch target. */
    const hitHeight = element => {
      const boxes = [element, ...element.querySelectorAll('.seg-hit')].map(node => node.getBoundingClientRect());
      return Math.max(...boxes.map(rect => rect.bottom)) - Math.min(...boxes.map(rect => rect.top));
    };
    const rgb = (css) => { const n = (css.match(/[\\d.]+/g) || []).map(Number); return css.startsWith('color(srgb') ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : [n[0], n[1], n[2], n[3] ?? 1]; };
    const words = (e) => [...e.children].map((child) => child.textContent.replace(/\\s+/g, ' ').trim()).join(' ');
    const probe = document.createElement('i');
    probe.style.color = 'var(--warn)';
    document.body.append(probe);
    const warn = getComputedStyle(probe).color;
    probe.style.color = 'var(--reject)';
    const reject = getComputedStyle(probe).color;
    // The held-row edge the shared stage token map draws: Gated grey mixed into the line colour (8221affabf).
    probe.style.borderTop = '1px solid color-mix(in oklab, var(--stage-gated) 45%, var(--line))';
    const gatedEdge = getComputedStyle(probe).borderTopColor;
    probe.remove();
    const rows = [...document.querySelectorAll('#chain .row')].map((row) => {
      const s = getComputedStyle(row), why = row.querySelector('.meta .item-reason');
      return { id: row.dataset.item, row: box(row), title: box(row.querySelector('.t')), age: box(row.querySelector('.row-age')),
        stage: row.querySelector('.item-stage')?.dataset.stage ?? null, stageDetail: row.querySelector('.stage-detail')?.textContent ?? null,
        meta: words(row.querySelector('.meta')), chip: row.querySelector(':scope > .row-side > .chip')?.textContent ?? null, waitTarget: row.querySelector(':scope > .row-side > .chip [data-go]')?.dataset.go ?? null,
        why: why ? { text: why.textContent, code: why.querySelector('[title]')?.title, color: getComputedStyle(why).color } : null, gated: row.classList.contains('gated'),
        border: rgb(s.borderTopColor), borderColor: s.borderTopColor, borderWidth: s.borderTopWidth, edges: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].every((c) => c === s.borderTopColor),
        tint: rgb(s.backgroundColor) };
    });
    const status = document.querySelector('.status');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      tabs: [...document.querySelectorAll('#tabs .tab')].map((tab) => tab.textContent),
      header: document.querySelector('.top').innerText.replace(/\\s+/g, ' ').trim(), live: document.querySelector('#live').textContent, liveInBar: !!document.querySelector('.status #live'),
      bar: [...document.querySelectorAll('.status [data-status]')].filter((part) => !part.hidden).map((part) => ({ to: part.dataset.status, text: part.textContent.replace(/\\s+/g, ' ').trim(), height: part.getBoundingClientRect().height })),
      barShown: getComputedStyle(status).display !== 'none', barBox: box(status), barTint: rgb(getComputedStyle(status).backgroundColor), barBlur: getComputedStyle(status).backdropFilter,
      rows, warn, reject, gatedEdge, state: view.state, lane: view.lane, tab: view.tab,
      chips: [...document.querySelectorAll('[data-filter-kind="state"]')].map((choice) => [choice.dataset.state, choice.querySelector('b').textContent, choice.getAttribute('aria-checked') === 'true']),
      lanes: [...document.querySelectorAll('[data-filter-kind="lane"]')].map((choice) => choice.querySelector('.filter-option-label').textContent + (choice.querySelector('b') ? ' · ' + choice.querySelector('b').textContent : '')), pick: box(document.querySelector('#filter-toggle')),
      seg: box(document.querySelector('.items-view-switch')), go: box(document.querySelector('#new-item')), toolbar: box(document.querySelector('.toolbar')),
      waiting: (() => { const fold = document.querySelector('[data-shout-filter=questions]'); return fold && { text: fold.textContent.replace(/\\s+/g, ' ').trim(), open: fold.getAttribute('aria-pressed'), height: hitHeight(fold), offset: fold.getBoundingClientRect().top - fold.closest('.shouts-card').getBoundingClientRect().top, cards: document.querySelectorAll('#feed .shout .mark.ask').length }; })(),
      idle: (() => { const fold = document.querySelector('#agents .fold-line[data-fold="idle"]'); return fold && { text: words(fold), open: fold.getAttribute('aria-expanded'), height: fold.getBoundingClientRect().height, pills: document.querySelectorAll('#agents .agent-pill').length }; })(),
      agentRows: [...document.querySelectorAll('#agents .agent-card')].filter((card) => card.getBoundingClientRect().height > 0).length,
    };
  })())`));
  const part = (r, to) => r.bar.find((p) => p.to === to);
  const number = (p) => Number(/^(\d+)/.exec(p?.text ?? '')?.[1] ?? NaN);
  const click = async (selector) => chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
  const settle = () => chrome.stable('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  /** Choose a filter through the real menu. */
  const filter = async (kind, value) => { await click('#filter-toggle'); await click(`[data-filter-choice="${kind}:${value}"]`); await settle(); };
  /** Choose a lane through the filter menu. */
  const lane = async (name) => filter('lane', name);
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 7 && !!document.querySelector('.status [data-status=\"items\"]')");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        await click('[data-tab=items]');
        await click('[data-tab=items]');
        await filter('state', 'active');
        await settle();
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll: ${JSON.stringify(r.page)}`);
        // The header carries the tabs and nothing else: no counts, no clock.
        assert.deepEqual(r.tabs, ['Dashboard', 'Items', 'Shouts', 'Spec', 'Doctrine', 'Activity', 'Roadmap', 'Cost'], `${at}: the tabs carry no counts`);
        assert.ok(r.live === '' && r.liveInBar && !/live|\d\d:\d\d/.test(r.header), `${at}: a live board says nothing in the header: ${r.header}`);
        // On a phone the bar stays out of the way while the board is live.
        if (width === 375) assert.equal(r.barShown, false, `${at}: no status bar on a phone while live`);
        // The bar: an opaque surface along the foot, the counts the tabs used to carry, and a part only where there is one.
        if (width === 1280) {
          assert.ok(Math.abs(r.barBox.bottom - 900) <= 1 && r.barBox.left === 0 && Math.abs(r.barBox.width - r.page.width) <= 1, `${at}: the bar runs along the foot: ${JSON.stringify(r.barBox)}`);
          assert.equal(r.barTint[3], 1, `${at}: the status bar uses the approved opaque surface: ${JSON.stringify(r.barTint)}`);
          assert.deepEqual(r.bar.map((p) => p.to).filter((to) => !to.startsWith('item:') && to !== 'activity'), ['items', 'agents', 'verify', 'gated', 'release'], `${at}: items, agents, to verify, gated and the release, then the last event: ${JSON.stringify(r.bar)}`);
          assert.deepEqual([part(r, 'items').text, part(r, 'verify').text, part(r, 'gated').text, part(r, 'release').text], ['6 items', '1 to verify', '2 gated', '1.0: first cut 0/3'], `${at}: what the parts say`);
        }
        // Rows: two lines, the age at the top right, the lane and up to three spec ids below, or the verdict instead.
        const row = Object.fromEntries(r.rows.map((x) => [x.id, x]));
        assert.deepEqual(r.rows.map((x) => x.id).sort(), ['1', '2', '3', '4', '5', '6'], `${at}: the active items`);
        const heights = r.rows.map((x) => Math.round(x.row.height));
        assert.ok(Math.max(...heights) - Math.min(...heights) <= 1 && Math.max(...heights) <= 64, `${at}: every row two lines and as tall as the next: ${heights}`);
        for (const x of r.rows) {
          assert.ok(x.row.right - x.age.right <= 14 && x.age.top < x.title.bottom && x.age.bottom > x.title.top, `${at}: #${x.id}'s age stands at the top right: ${JSON.stringify([x.row, x.title, x.age])}`);
        }
        assert.equal(row['1'].meta, 'web G1, G2, G3 +1', `${at}: the lane and the first three spec ids, then how many more`);
        assert.deepEqual([row['6'].why?.text, row['6'].why?.color === r.reject, /\bweb\b/.test(row['6'].meta.replace('Behavior did not match', '')), /next line/.test(row['6'].meta)], ['Behavior did not match', true, false, false],
          `${at}: a sent-back row says why in the warning colour, first line only, in place of its lane: ${row['6'].meta}`);
        assert.equal(row['6'].why?.code, 'BEHAVIOR_MISMATCH', `${at}: the row keeps its native reason code in the tooltip`);
        // A lane hold keeps its own edge on every side, in the Gated grey of the shared stage token map (8221affabf), never
        // a coloured warning bar; dependency waits use the approved plain linked chip. Review stays gold.
        for (const id of ['4']) {
          assert.ok(row[id].gated && row[id].edges && row[id].borderWidth === '1px' && row[id].borderColor === r.gatedEdge && r.gatedEdge !== row['1'].borderColor,
            `${at}: #${id} has the Gated grey edge ${r.gatedEdge}: ${JSON.stringify(row[id])}`);
        }
        assert.deepEqual([row['3'].gated, row['3'].border, row['3'].borderWidth, row['3'].edges], [true, row['1'].border, row['1'].borderWidth, true], `${at}: a dependency wait has the same plain edge as an unclaimed row`);
        assert.deepEqual([row['3'].stage, row['3'].stageDetail], ['gated', 'by #2'], `${at}: the row's stage names the native dependency`);
        const [tr, tg, tb] = row['5'].tint;
        assert.ok(tr >= tg && tg > tb && row['5'].tint.join() !== row['1'].tint.join(), `${at}: a row waiting on a verdict is shaded gold: ${JSON.stringify([row['5'].tint, row['1'].tint])}`);
        if (scheme === 'dark') {
          const [gr, gg, gb] = row['5'].border;
          assert.ok(row['5'].edges && gr > gb + 30 && gg > gb + 20, `${at}: in dark it has a gold outline too: ${row['5'].border}`);
        }
        // The view toggle, Filter and New item stay on one line at both widths.
        await click('#filter-toggle');
        const menu = await read();
        assert.deepEqual(menu.lanes, ['All lanes', 'web · 5', 'api · 1'], `${at}: each lane with its count under Active`);
        await click('#filter-toggle');
        const centre = (b) => b.top + b.height / 2;
        assert.ok(Math.abs(centre(r.seg) - centre(r.pick)) <= 4 && Math.abs(centre(r.pick) - centre(r.go)) <= 4, `${at}: one line: ${JSON.stringify([r.seg, r.pick, r.go])}`);
      }
    }

    // Each part opens exactly what it counts: its number is the length of the list it opens.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await click('[data-tab=items]');
    await filter('state', 'all');
    let r = await read();
    for (const [to, state, label] of [['verify', 'verify', 'To verify'], ['gated', 'gated', 'Gated'], ['items', 'active', 'Active']]) {
      const n = number(part(r, to));
      await click(`.status [data-status="${to}"]`);
      await chrome.waitFor(`view.tab === 'items' && view.state === '${state}'`);
      await settle();
      r = await read();
      await click('#filter-toggle');
      r = await read();
      const on = r.chips.find(([, , isOn]) => isOn);
      assert.deepEqual([on?.[0], Number(on?.[1]), r.rows.length], [state, n, n], `${to}: the bar's ${n} opens ${label}, which counts and lists the same ${n}: ${JSON.stringify(r.chips)}`);
      await click('#filter-toggle');
      if (to === 'gated') assert.ok(r.rows.every((x) => x.gated), 'every row it opens is a gated row');
    }
    await click('[data-tab=items]');
    await filter('state', 'active');
    await click('.status [data-status="agents"]');
    await chrome.waitFor("view.tab === 'dashboard' && view.addressDetail === 'floor'");
    r = await read();
    assert.ok(number(part(r, 'agents')) > 0, 'the agents part opens the agent floor it counts');
    // The release part opens the Roadmap on that release alone: its rows are the ones it counts.
    await click('.status [data-status="release"]');
    await chrome.waitFor("view.tab === 'roadmap'");
    const roadmapRows = () => chrome.stable("document.querySelectorAll('#roadmap .milestone-item').length");
    assert.deepEqual([await chrome.stable("[...document.querySelectorAll('#roadmap .milestone h2')].map((h) => h.textContent).join()"), await roadmapRows()], ['1.0: first cut', 3],
      'the release the part counts, and only its three items');
    await click('#roadmap [data-roadmap-all]');
    assert.equal(await roadmapRows(), 6, 'show all brings back every release');
    const last = r.bar.find((p) => p.to.startsWith('item:'));
    if (last) {
      await click(`.status [data-status="${last.to}"]`);
      await chrome.waitFor(`view.tab === 'items' && view.item === ${Number(last.to.slice(5))}`);
    }

    // Lanes narrow the list as states do, each counting within the other's choice.
    await click('[data-tab=items]');
    await filter('state', 'active');
    await lane('api');
    r = await read();
    await click('#filter-toggle');
    r = await read();
    assert.deepEqual([r.lane, r.rows.map((x) => x.id), r.chips.find(([name]) => name === 'active')[1], r.chips.find(([name]) => name === 'verified')[1]], ['api', ['4'], '1', '0'], 'api narrows the list and the state counts');
    await click('#filter-toggle');
    await lane('');
    await click('[data-tab=items]');
    await filter('state', 'verified');
    await lane('web');
    r = await read();
    await click('#filter-toggle');
    r = await read();
    assert.deepEqual([r.lane, r.rows.map((x) => x.id), r.lanes], ['web', ['7'], ['All lanes', 'web · 1']], 'under Verified the lanes count what is verified');
    await click('#filter-toggle');
    await lane('');
    await click('[data-tab=items]');
    await filter('state', 'active');

    // Shouts: the native Questions segment opens the question conversation; idle agents retain their fold.
    await click('[data-tab=shouts]');
    await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden && !!document.querySelector('[data-shout-filter=questions]')");
    r = await read();
    const shut = r.waiting.offset;
    assert.deepEqual([r.waiting.text, r.waiting.open, r.waiting.cards], ['Questions1', 'false', 0], `the question count stays on the composer line before a conversation is opened: ${JSON.stringify(r.waiting)}`);
    assert.ok(/^\d+ idle show$/.test(r.idle.text) && r.idle.open === 'false' && r.idle.pills === 0, `the idle agents fold to a line: ${JSON.stringify(r.idle)}`);
    await click('[data-shout-filter=questions]');
    await openShoutConversation(chrome);
    await click('#agents .fold-line[data-fold="idle"]');
    r = await read();
    assert.deepEqual([r.waiting.open, r.waiting.cards, r.idle.open, r.idle.pills > 0], ['true', 1, 'true', true], 'the Questions segment reveals the real question and the idle fold opens on a click');
    assert.equal(r.waiting.offset, shut, 'and the line stays where it was as its cards open under it');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    r = await read();
    assert.ok(r.waiting.height >= 44 && r.idle.height >= 44, 'the Questions segment and idle fold are 44px targets');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280');

    // A shout that lands while Items is open counts as unread in the bar. The part opens exactly that shout, not the ones
    // already read beside it, and opening it reads it; show all brings the rest back.
    await click('[data-tab=items]');
    const alreadyRead = await chrome.stable('data.project.shouts.length');
    assert.ok(alreadyRead >= 2, `shouts the person has already read: ${alreadyRead}`);
    box.run(alpha.web, 'shout', 'all', 'web-1 is on it');
    await chrome.waitFor("!document.querySelector('#status-unread')?.hidden && document.querySelector('#status-unread')?.textContent === '1 unread'", 15_000); // budget: hang ceiling for the unread bar after the native shout; no throughput claim.
    await click('#status-unread');
    await chrome.waitFor("view.tab === 'shouts' && document.querySelector('#status-unread')?.hidden === true");
    await openShoutConversation(chrome);
    const feed = async () => JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#feed .shout .text')].map((text) => text.textContent))"));
    assert.deepEqual([await feed(), await chrome.stable("document.querySelector('#feed .feed-bar span').textContent")], [['web-1 is on it'], '1 unread show all'],
      `1 unread opens that one shout, not the ${alreadyRead} already read`);
    await click('#feed [data-unread]');
    await click('[data-shout-filter=all]');
    await openShoutConversation(chrome);
    assert.equal((await feed()).length, alreadyRead + 1, 'show all brings back the shouts already read');

    // Cut off from the board, the bar turns red and says why. Stopping the view drops the board's event stream for real.
    await view.stop();
    await chrome.waitFor("document.querySelector('#live').textContent.startsWith('offline')", 15_000); // budget: hang ceiling for the offline state after fetch rejection; no rendering-speed claim.
    r = await read();
    const [red, green, blue] = r.barTint;
    assert.ok(red > green + 10 && red > blue + 10 && r.bar.length > 0, `the bar turns red and keeps its parts: ${JSON.stringify(r.barTint)}`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    r = await read();
    assert.ok(r.barShown && r.live.startsWith('offline'), 'on a phone too, a view cut off from the board says so');
    assert.ok(r.bar.every((p) => p.height >= 44), `and its parts are 44px targets there: ${JSON.stringify(r.bar)}`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
