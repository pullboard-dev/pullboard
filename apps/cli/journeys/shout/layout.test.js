// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/cost.css apps/view/src/io/doctrine.css apps/view/src/io/item/panel.css apps/view/src/io/item/rows.css */
/** @pullboard-test-gui */
/** Cockpit layout checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import {
  openShoutConversation,
  SPEC,
  machine,
  project,
  build,
  fetchLive,
  fetchPage,
  startView,
  styleOf,
  element,
  settle,
  storage,
  openPage,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  tabBar,
} from '../../tests/fixtures/cockpit/harness.js';


/** Send a fixture back using the exact frozen clause, keeping native rejection guards active. */
async function sendBackWithClause(box, project, id, note, clause) {
  box.git(project.repo, 'switch', '-q', '--detach', project.itemBranches.get(`${project.baseBranch}:${id}`) ?? project.branch);
  await box.inProcess(project.repo, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--note', note, '--clause', clause, '--as', 'coordinator');
  box.git(project.repo, 'switch', '-q', 'main');
}


test('the view never scrolls sideways at 320px [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the 320px check.');

  const box = machine();
  const demo = project(box, 'narrow');
  await box.inProcess(demo.repo, 'add', 'web', 'A title long enough to need every bit of a narrow phone row, and then some more words', '--specs', 'G1', '--criterion', 'fits');
  await box.inProcess(demo.repo, 'add', 'web', 'Built, then sent back', '--specs', 'G1', '--criterion', 'back');
  build(box, demo, 2, 'two.txt');
  await sendBackWithClause(box, demo, 2, 'It misses the edge the criterion names, a reason long enough to wrap on a phone.', 'back');
  const sha = box.git(demo.repo, 'rev-parse', 'HEAD').trim();
  await box.inProcess(demo.repo, 'shout', 'web', `Run \`pullboard next --verify\` and read SPEC.md:1-2@${sha} before you take #1.`);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-sideways-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    // A fresh board opens on the first-run Dashboard (0de17112c6); set it aside so the tabs under test render.
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await chrome.click("document.querySelector('[data-tab=\"items\"]')");
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 2');
    // This machine's fonts first, then a wide one (Verdana here, DejaVu Sans on Linux) at 320 and at 305,
    // the room a 320px screen leaves beside a classic 15px scrollbar: Linux CI measured 324px of tabs there.
    for (const [width, font] of [[320, ''], [320, 'Verdana, "DejaVu Sans", sans-serif'], [305, 'Verdana, "DejaVu Sans", sans-serif']]) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await chrome.stable(`document.documentElement.style.setProperty('--sans', ${JSON.stringify(font || 'system-ui, sans-serif')})`);
    await chrome.waitFor(`innerWidth === ${width}`);
    for (const tab of ['dashboard', 'items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap']) {
      await chrome.click(`document.querySelector('[data-tab="${tab}"]')`);
      await chrome.waitFor(`!document.querySelector('[data-pane="${tab}"]').hidden`);
      const seen = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const edge = document.documentElement.clientWidth;
        // Name each element that runs past the edge with nothing above it to clip or scroll it.
        const clipped = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (!['visible', ''].includes(getComputedStyle(p).overflowX)) return true; return false; };
        const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
        const past = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > edge + 0.5 && !clipped(e); })
          .map((e) => name(e) + ' right ' + Math.round(e.getBoundingClientRect().right) + ': ' + (e.textContent || '').trim().slice(0, 40));
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: edge, past: past.slice(0, 8), more: Math.max(0, past.length - 8) };
      })())`));
      assert.ok(seen.scrollWidth <= seen.clientWidth, `${width}${font ? ' in a wide font' : ''}, ${tab}: the page scrolls sideways, ${seen.scrollWidth} wide in ${seen.clientWidth}; past the edge: ${seen.past.join(' | ')}${seen.more ? ` (+${seen.more} more)` : ''}`);
    }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the Dashboard and retained tabs fit two rows on a phone [N26]', async () => {
  const view = await startView(machine());
  try {
    const html = await (await fetchPage(view)).text();
    const style = await styleOf(view);
    const phone = /@media \(width < 480px\) \{\n([^@]*?)\n\}/.exec(style)?.[1] ?? '';
    assert.doesNotMatch(style, /max-width: 480px/, 'at 480px itself the tabs keep their row');
    assert.match(phone, /\.tabs \{ flex: 1 1 100%; display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); grid-auto-flow: row;/, 'under 480px eight full labels share two rows of four');
    assert.match(phone, /\.tab \{ display: grid; justify-items: center; align-content: center;/, 'each tab centres its label in its share');
    assert.match(style, /\n\.tabs \{ display: flex; flex-wrap: wrap; gap: var\(--space-0\); \}\n/, 'wider, the tabs keep the row they have');
    const tabs = [...html.matchAll(/<button class="tab" data-tab="([a-z]+)" type="button">([A-Za-z]+)<\/button>/g)];
    assert.deepEqual(tabs.map((match) => match[2]), ['Dashboard', 'Items', 'Shouts', 'Spec', 'Doctrine', 'Activity', 'Roadmap', 'Cost'], 'Dashboard leads the retained tabs, each its label alone: their counts are in the status bar');
  } finally {
    await view.stop();
  }
});

test('the view has a light and a dark theme to choose [N26]', async () => {
  const view = await startView(machine());
  try {
    const store = storage();
    const page = await openPage(view, { store });
    const style = await styleOf(view);
    const tokens = /\n:root \{\n([^}]*)\n\}\n/.exec(style)?.[1] ?? '';
    // One list of tokens: every colour in it holds a light and a dark value.
    const colours = [...tokens.matchAll(/(--[a-z0-9-]+): ([^;]*(?:#[0-9a-f]{3,8}|rgba?\()[^;]*);/g)];
    assert.ok(colours.length >= 20, 'the colour tokens');
    assert.deepEqual(colours.filter((colour) => !colour[2].startsWith('light-dark(')).map((colour) => colour[1]), [], 'each holds a light and a dark value');
    assert.match(tokens, /^ {2}color-scheme: light dark;$/m, 'and they follow the system until the person picks');
    assert.match(style, /\n:root\[data-theme="light"\] \{ color-scheme: light; \}\n:root\[data-theme="dark"\] \{ color-scheme: dark; \}\n/, 'a pick sets the scheme the tokens answer to');
    assert.doesNotMatch(style, /prefers-color-scheme/, 'no second list for dark');
    assert.match(page.html, /<div class="side-top">\n(?: {4}<[^\n]*\n)*? {4}<button class="theme-btn" id="theme" type="button" title="Theme: system">[^\n]*<\/button>\n {2}<\/div>/, 'the button sits in the bar atop the sidebar, which is the top bar on a phone');

    const theme = (on) => [on.run('document.documentElement.dataset.scheme'), on.element('theme').title];
    assert.deepEqual([...theme(page), page.run('document.documentElement.dataset.theme') ?? null], ['dark', 'Dark theme: switch to light', null], 'with none picked it follows the system\'s theme');
    const presses = [];
    for (let press = 0; press < 3; press += 1) {
      await page.fire('theme', 'click');
      presses.push(theme(page));
    }
    assert.deepEqual(presses, [['light', 'Light theme: switch to dark'], ['dark', 'Dark theme: switch to light'], ['light', 'Light theme: switch to dark']], 'each press switches between light and dark, and the title says which is on');

    await page.fire('theme', 'click');
    await page.fire('theme', 'click');
    assert.deepEqual(theme(await openPage(view, { store })), ['light', 'Light theme: switch to dark'], 'a reload keeps the pick');
    assert.deepEqual(theme(await openPage(view)), ['dark', 'Dark theme: switch to light'], 'a browser that keeps nothing follows the system');
    assert.ok(['light', 'dark'].includes(store.getItem('pb.theme')), 'and what is kept is only ever light or dark');
  } finally {
    await view.stop();
  }
});

test('no box carries a coloured edge [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  await sendBackWithClause(box, alpha, 1, 'no greeting yet', 'greets');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const style = await styleOf(view);
    // Every border drawn on one side of a box is nothing, or a 1px divider in the neutral line colour.
    const sides = [...style.matchAll(/border-(?:top|bottom|left|right|inline|block)[a-z-]*:\s*([^;}]+)/g)].map((match) => match[0].trim());
    assert.ok(sides.length > 0);
    assert.deepEqual(sides.filter((side) => !/^border-(?:top|bottom|left|right): (?:0|1px solid var\(--line(?:-soft)?\))$/.test(side)), [], 'no coloured or thick bar on one edge');
    assert.doesNotMatch(style, /box-shadow:[^;}]*inset -?\d+(?:\.\d+)?px 0 0/, 'and no stripe drawn by a shadow');

    await page.click({ go: 'item:1' });
    assert.match(page.show('detail'), /<div class="verdict no"><b>Sent back · <span title="BEHAVIOR_MISMATCH">Behavior did not match<\/span><\/b>/, 'a verdict says what it decided');
    assert.match(style, /\.verdict\.yes b \{ color: var\(--accent-strong\); \} \.verdict\.no b \{ color: var\(--reject\); \}/, 'in the colour of its word, not a bar');
  } finally {
    await view.stop();
  }
});
test("the authenticated local view assembles its shared and private styles [N26]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', SPEC, { products: { Pages: ['G1', 'G2'] } });
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.doesNotMatch(page.html, /<style|style=/, 'the page holds no styles');
    assert.match(page.html, /\n<link rel="stylesheet" href="\/view\.css">\n/, 'it links its own, at a clean address the session cookie opens');
    assert.ok(!page.html.includes(view.key), 'the page holds no secret');
    const css = await fetchPage(view, '/view.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    const dashboardCss = readFileSync(new URL("../../../view/src/io/dashboard.css", import.meta.url), 'utf8').trimEnd();
    const sharedCss = readFileSync(new URL("../../../view/src/io/main.css", import.meta.url), 'utf8').replace('/* @pullboard-dashboard-styles */', dashboardCss).replace('/* @pullboard-items-row-styles */', readFileSync(new URL("../../../view/src/io/item/rows.css", import.meta.url), 'utf8').trimEnd()).replace('/* @pullboard-stage-styles */', readFileSync(new URL("../../../view/src/io/stage.css", import.meta.url), 'utf8').trimEnd());
    const privateCss = readFileSync(new URL("../../../view/src/io/cost.css", import.meta.url), 'utf8');
    const doctrineCss = readFileSync(new URL("../../../view/src/io/doctrine.css", import.meta.url), 'utf8');
    const itemPanelCss = readFileSync(new URL("../../../view/src/io/item/panel.css", import.meta.url), 'utf8');
    assert.equal(sharedCss.split('/* @private-view-css src/view/cost.css */').length - 1, 1, 'the local view has one private-style insertion point');
    assert.equal(sharedCss.split('/* @shared-view-css src/view/doctrine.css */').length - 1, 1, 'the shared view has one Doctrine-style insertion point');
    assert.equal(sharedCss.split('/* @shared-view-css src/view/item-panel.css */').length - 1, 1, 'the shared view has one item-panel style insertion point');
    const expectedCss = sharedCss.replace('/* @shared-view-css src/view/doctrine.css */', doctrineCss)
      .replace('/* @shared-view-css src/view/item-panel.css */', itemPanelCss).replace('/* @private-view-css src/view/cost.css */', privateCss);
    assert.equal(await css.text(), expectedCss, 'the authenticated view assembles shared Dashboard, Doctrine and item-panel styles plus private Cost styles in source order');
    assert.equal((await fetchLive(`${view.base}/view.css`)).status, 403, 'nothing without the secret');
    const stranger = await new Promise((done, fail) => {
      request({ host: '127.0.0.1', port: view.link.port, path: `/view.css?k=${view.key}`, headers: { host: 'pullboard.example' } }, (res) => done(res.statusCode)).on('error', fail).end();
    });
    assert.equal(stranger, 403, 'nor under another Host');
    const policy = (await fetchPage(view)).headers.get('content-security-policy');
    assert.equal(/(?:^|; )style-src ([^;]*)/.exec(policy)?.[1], "'self'", 'styles come from the view alone, never inline');

    // Nothing the script draws carries a style either: products, the list, a picked item, a spec row.
    await page.click({ go: 'item:1' });
    await page.click({ tab: 'spec' });
    await page.click({ rows: 'spec:all' });
    await page.click({ row: 'spec:G1' });
    assert.match(page.show('prod-list'), /<svg class="bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect width="50" height="1"\/><\/svg>/, 'a product bar is drawn, half full');
    // The approved item-panel header spaces its status row with a grid gap; spec metadata keeps its own spacing.
    const style = await styleOf(view);
    assert.match(page.show('detail'), /<\/h2><div class="item-panel-status">/);
    assert.match(page.show('spec-detail'), /<\/h2><div class="meta">/);
    assert.match(style, /\n\.meta \{ [^}]*margin-top: var\(--space-0\); \}\n/);
    assert.match(style, /\n\.item-panel-head \{ [^}]*gap: var\(--space-2\); \}\n/);
    assert.doesNotMatch(style, /h2 \+ \.meta/, 'no rule reaches past the item into a spec row');
    for (const id of [...page.html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])) {
      assert.doesNotMatch(page.show(id), /style=/, `#${id} holds no style`);
    }
  } finally {
    await view.stop();
  }
});

test('the status bar holds one line under no pointer [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for status bar media checks.');

  const box = machine();
  const demo = project(box, 'pointer-none');
  for (let index = 1; index <= 3; index += 1) {
    await box.inProcess(demo.repo, 'add', 'web', `Status item ${index}`, '--specs', 'G1', '--criterion', 'visible on the board');
  }
  await box.inProcess(demo.web, 'shout', 'coordinator', 'Which status label should we use?', '--kind', 'question');
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
  const add = (lane, title, ...more) => box.inProcess(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'renders', ...more);
  await fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Free', criterion: 'renders', args: ['--specs', 'G1,G2,G3,G4'], run: async (root, ...argv) => ({ code: 0, out: await box.inProcess(root, ...argv) }) });
  await add('web', 'Base');
  await add('web', 'Depends', '--after', '2');
  await add('api', 'Api work');
  await add('web', 'Shipped');
  await add('web', 'Bounced');
  await add('web', 'Done');
  build(box, alpha, 5, 'shipped.html');
  build(box, alpha, 6, 'bounced.html');
  build(box, alpha, 7, 'done.html');
  await sendBackWithClause(box, alpha, 6, 'the footer is missing\nand more on the next line', 'renders');
  accept(box, alpha, 7);
  await box.inProcess(alpha.web, 'claim', '2');
  await box.inProcess(alpha.repo, 'hold', 'api', '--reason', 'API freeze');
  await box.inProcess(alpha.repo, 'milestone', 'add', '1.0: first cut', '--note', 'The first pages', '--items', '1,5,7', '--reason', 'Arrange fixture release');
  await box.inProcess(alpha.repo, 'milestone', 'add', '2.0: the rest', '--note', 'After the first cut', '--items', '2,3,4', '--reason', 'Arrange fixture release');
  const second = join(box.dir, 'glance-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/glance2');
  await joinFixtureSeat(box, second, 'web', { run: async (root, ...argv) => ({ code: 0, out: await box.inProcess(root, ...argv) }) });
  await box.inProcess(second, 'shout', 'all', 'Free when you need me.');
  await box.inProcess(alpha.repo, 'shout', 'web', 'Pages first, then the footer.');
  await box.inProcess(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision', '--kind', 'question');

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
    await box.inProcess(alpha.web, 'shout', 'all', 'web-1 is on it');
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

test('the project corner and the theme read the same everywhere [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for project corner checks.');
  const box = machine();
  const alpha = project(box, 'corner-alpha', `${SPEC}- G3 [pending] Should the greeting name the visitor? | gate: review\n- G4 [draft, must] The footer links home. | gate: web test\n`);
  project(box, 'corner-beta');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.web, 'claim', '1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-corner-chrome-'));
  let chrome;
  /** The corner, the project list and the theme button as they read. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    const rgb = (css) => (css.match(/[\\d.]+/g) || []).map(Number);
    const probe = document.createElement('i'); probe.style.color = 'var(--warn)'; document.body.append(probe); const warn = getComputedStyle(probe).color; probe.remove();
    const theme = document.querySelector('#theme'), bar = document.querySelector('header.top'), side = document.querySelector('#side');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      mode: document.documentElement.dataset.side || 'docked', logo: box(document.querySelector('#side-toggle svg')), name: box(document.querySelector('#proj-name')),
      wordmark: shown(document.querySelector('#side-toggle span')), arrow: shown(document.querySelector('#proj-switch small')),
      rows: [...document.querySelectorAll('#proj-list .proj.repo')].filter(shown).map((row) => {
        const s = getComputedStyle(row), asks = row.querySelector('small .asks');
        return { name: row.querySelector('.pname').textContent, line: row.querySelector('small').textContent, pill: !!row.querySelector('.need'), on: row.classList.contains('on'),
          asks: asks ? { text: asks.textContent, first: row.querySelector('small').firstElementChild === asks, warn: getComputedStyle(asks).color === warn } : null,
          tint: rgb(s.backgroundColor), edge: rgb(s.borderTopColor) };
      }),
      theme: { scheme: document.documentElement.dataset.scheme || null, title: theme.title, box: box(theme), bar: box(bar), picked: document.documentElement.dataset.theme || null, side: box(side) },
    };
  })())`));
  const click = (selector) => chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
  /** A drawn frame: the page hears of a colour-scheme change at its next one. */
  const frame = () => chrome.stable('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  const middle = (b) => b.top + b.height / 2;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    // Project names can arrive before their states; measure the corner only after the board is drawn.
    await chrome.waitFor("data?.projects?.length === 2 && data.root === view.root && !document.body.classList.contains('loading') && document.querySelector('header.top').getBoundingClientRect().width > 0 && !!document.querySelector('#proj-list .proj.repo')");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        const r = await read();
        assert.ok(r.page.scroll <= r.page.width, `${at}: no sideways scroll`);
        assert.equal(r.wordmark, false, `${at}: the corner is the logo mark, never a wordmark`);
        // The theme button sits centred in the top bar. On a wide screen that is the tab bar; on a phone it is the
        // project bar, the page's first row (the logo, the project, the theme), with the tabs under it.
        const top = width === 375 ? r.theme.side : r.theme.bar;
        assert.ok(Math.abs(middle(r.theme.box) - middle(top)) <= 2 && r.theme.box.left >= top.left && r.theme.box.right <= top.right, `${at}: the theme button sits centred in the top bar: ${JSON.stringify(r.theme)}`);
        if (width === 375) assert.ok(top.top <= 0.5 && r.theme.bar.top >= top.bottom - 1, `${at}: on a phone the top bar is the project bar, the tabs under it: ${JSON.stringify(r.theme)}`);
        if (width === 375) continue;
        // In the project list: a project is its name and what it holds, what needs the person first in the warning
        // colour; no count pills; the project shown a quiet neutral tint, no coloured edge.
        const [shownRow, other] = [r.rows.find((row) => row.on), r.rows.find((row) => !row.on)];
        assert.ok(r.rows.length === 2 && r.rows.every((row) => !row.pill), `${at}: two projects, no count pills: ${JSON.stringify(r.rows)}`);
        assert.deepEqual([shownRow.name, shownRow.asks?.text, shownRow.asks?.first, shownRow.asks?.warn], ['corner-alpha', '1 question · 1 draft row', true, true], `${at}: what needs the person comes first, in the warning colour: ${JSON.stringify(shownRow)}`);
        assert.equal(other.asks, null, `${at}: a project needing nothing says only what it holds`);
        const [tr, tg, tb] = shownRow.tint, [er, eg, eb] = shownRow.edge;
        assert.ok(Math.max(tr, tg, tb) - Math.min(tr, tg, tb) <= 14 && Math.max(er, eg, eb) - Math.min(er, eg, eb) <= 14, `${at}: the project shown is a neutral tint with no coloured edge: ${JSON.stringify(shownRow)}`);
      }
    }

    // The corner is the same docked and collapsed: the logo, then the name, in the same place; collapsed, the name opens
    // the list, so only then does it carry its arrow.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await frame();
    const docked = await read();
    await click('#side-toggle');
    await chrome.waitFor('document.documentElement.dataset.side === "collapsed"');
    const collapsed = await read();
    for (const part of ['logo', 'name']) {
      assert.ok(Math.abs(docked[part].left - collapsed[part].left) <= 1 && Math.abs(docked[part].top - collapsed[part].top) <= 1 && Math.abs(docked[part].height - collapsed[part].height) <= 1,
        `the ${part} keeps its place and size: ${JSON.stringify([docked[part], collapsed[part]])}`);
    }
    assert.deepEqual([docked.mode, docked.arrow, collapsed.mode, collapsed.arrow], ['docked', false, 'collapsed', true], 'the arrow only where the name opens a list');

    /** Read whether the Settings and GitHub project tools are visible in their sidebar container. */
    const footer = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const bar = document.querySelector('.side-footer'), settings = bar?.querySelector('[data-tab="settings"]'), github = bar?.querySelector('a[href]');
      const shown = (element) => { const style = element && getComputedStyle(element), rect = element?.getBoundingClientRect(); return !!element && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0; };
      return { bottomSibling: bar === document.querySelector('#side').lastElementChild && !bar.closest('#side-body'), settings: shown(settings), settingsText: settings?.textContent.trim(), github: shown(github), githubText: github?.textContent.trim(), footer: shown(bar) };
    })())`));
    assert.deepEqual(await footer(), { bottomSibling: true, settings: false, settingsText: 'Settings', github: false, githubText: 'GitHub ↗', footer: false }, 'collapsed, project tools leave the short logo row without shrinking it');
    await click('#proj-switch');
    await chrome.waitFor("document.querySelector('#side').classList.contains('open') && getComputedStyle(document.querySelector('.side-footer')).display === 'flex'");
    assert.deepEqual(await footer(), { bottomSibling: true, settings: true, settingsText: 'Settings', github: true, githubText: 'GitHub ↗', footer: true }, 'the collapsed desktop popover exposes both project tools as visible controls');
    assert.equal(await chrome.stable(`(() => {
      const tools = document.querySelector('.side-footer').getBoundingClientRect();
      const project = document.querySelector('#proj-list .proj').getBoundingClientRect();
      return tools.bottom <= project.top && tools.right <= document.documentElement.clientWidth;
    })()`), true, 'the collapsed tools fit above the project choices without covering them');
    await click('.side-footer [data-tab="settings"]');
    await chrome.waitFor("document.querySelector('#settings-pane') && !document.querySelector('#settings-pane').hidden");
    assert.equal(await chrome.stable("document.querySelector('#settings-pane').hidden"), false, 'the Settings action opens its pane from the collapsed desktop popover');

    // The theme is light or dark: it starts from the system's, each press switches, the title says which, a reload keeps
    // it; collapsed, the button still sits centred in the top bar.
    assert.deepEqual([collapsed.theme.scheme, collapsed.theme.title, collapsed.theme.picked], ['light', 'Light theme: switch to dark', null], 'none picked yet: the system\'s, light here');
    // With none picked the page follows the system as it changes.
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await frame();
    await chrome.waitFor("document.documentElement.dataset.scheme === 'dark'");
    assert.equal((await read()).theme.title, 'Dark theme: switch to light', 'and the button says so');
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await frame();
    await chrome.waitFor("document.documentElement.dataset.scheme === 'light'");
    assert.ok(Math.abs(middle(collapsed.theme.box) - middle(collapsed.theme.bar)) <= 2, `the button sits centred in the top bar: ${JSON.stringify(collapsed.theme)}`);
    await click('#theme');
    assert.deepEqual(Object.values((await read()).theme).slice(0, 2), ['dark', 'Dark theme: switch to light'], 'a press switches to dark');
    await click('#theme');
    assert.deepEqual([...Object.values((await read()).theme).slice(0, 2), await chrome.stable("localStorage.getItem('pb.theme')")], ['light', 'Light theme: switch to dark', 'light'], 'the next press is light again, never back to following the system');
    await click('#theme');
    await chrome.send('Page.reload');
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('#theme')");
    assert.deepEqual(Object.values((await read()).theme).slice(0, 2), ['dark', 'Dark theme: switch to light'], 'presses switch between the two, and a reload keeps the last');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('targets are 44px for touch and compact under a mouse [N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for target size checks.');
  const box = machine();
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, api: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, 'targets', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'api', 'Endpoint', '--specs', 'G1', '--criterion', 'answers');
  await box.inProcess(alpha.web, 'claim', '1');
  await box.inProcess(alpha.web, 'shout', 'all', 'Greeting is under way; see #2 after.');
  // A shout that is only a reference: nothing shares its line, so it is a target like any button.
  await box.inProcess(alpha.web, 'shout', 'all', '#2');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-targets-chrome-'));
  let chrome;
  /** Every visible enabled action with its height, which references sit in running text, and the named compact ones. */
  const audit = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const visible = (e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return !e.disabled && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !e.closest('[hidden]'); };
    const targetHeight = e => { const box = e.getBoundingClientRect(), edges = e.matches('.seg button') ? [...e.querySelectorAll('.seg-hit')].map(edge => edge.getBoundingClientRect()) : []; return Math.max(box.bottom, ...edges.map(edge => edge.bottom)) - Math.min(box.top, ...edges.map(edge => edge.top)); };
    const height = (s) => { const e = document.querySelector(s); return e && visible(e) ? Math.round(targetHeight(e)) : null; };
    const selector = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[data-tab],[data-go],[data-item],[data-state],[data-row],[data-new]';
    // A reference inside running text is exempt from 44px, as WCAG 2.5.8 exempts inline targets: only the elements named
    // here, and only where text that is not another control's shares their line in the same block.
    const named = (e) => e.matches('.feed button.ref, .feed a.ref[data-go], .shout button.ref, .shout a.ref[data-go], .shout .band a, .detail button.ref, .detail a.ref[data-go], .t button.ref, .t a.ref[data-go]') || !!e.closest('#chain .meta .gate, #detail .kv dd.waits-on');
    const inLine = (e) => {
      let block = e.parentElement;
      while (block.parentElement && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement;
      const r = e.getBoundingClientRect(), walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        const owner = node.parentElement.closest(selector);
        if (e.contains(node) || !node.textContent.trim() || (owner && owner !== block && block.contains(owner))) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if ([...range.getClientRects()].some((line) => line.width > 0 && line.top < r.bottom && line.bottom > r.top)) return true;
      }
      return false;
    };
    const controls = [...new Set(document.querySelectorAll(selector))].filter(visible).map((e) => ({ text: (e.innerText || e.getAttribute('aria-label') || e.id || e.className).trim().slice(0, 40), height: targetHeight(e),
      inline: named(e) && inLine(e), named: named(e), inLine: inLine(e) }));
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      tap: getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(), coarse: matchMedia('(pointer: coarse)').matches,
      short: controls.filter((c) => c.height < 44 && !c.inline), count: controls.length,
      exempt: controls.filter((c) => c.named).map((c) => ({ text: c.text, height: Math.round(c.height), inLine: c.inLine })), standalone: inLine(document.querySelector('#new-item')),
      toolbar: { views: [...document.querySelectorAll('.items-view-switch button')].filter(visible).map((b) => Math.round(targetHeight(b))), filter: height('#filter-toggle'), go: height('#new-item') },
      composer: { text: height('#shout-text'), send: height('#shout-send') }, status: [...document.querySelectorAll('.status [data-status]')].filter(visible).map((b) => Math.round(b.getBoundingClientRect().height)),
    };
  })())`));
  const tab = async (name) => { await chrome.click(`document.querySelector('[data-tab=${name}]')`); await chrome.waitFor(`!document.querySelector('[data-pane=${name}]').hidden`); };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.items?.length === 2 && data.project.shouts.length >= 2");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        await tab('items');
        const items = await audit();
        await tab('shouts');
        await openShoutConversation(chrome, 'item:2');
        const shouts = await audit();
        for (const r of [items, shouts]) assert.ok(r.page.scroll <= r.page.width, `${at}: no sideways scroll`);
        if (width === 375) {
          // In a narrow window every action is a 44px target, as a finger needs.
          assert.equal(items.tap, '44px', `${at}: the target is 44px`);
          for (const [name, r] of [['Items', items], ['Shouts', shouts]]) assert.deepEqual(r.short, [], `${at} ${name}: every action at least 44px high: ${JSON.stringify(r.short)}`);
          // In native ascending message order, the named references retain their sizes: #2 alone is a 44px target; only the #2 inside the shout's sentence, in a
          // line of its words, is exempt. The same check refuses a standalone button.
          assert.deepEqual([items.exempt, shouts.exempt.map((e) => [e.text, e.inLine, e.height >= 44])], [[], [['#2', true, false], ['#2', false, true]]], `${at}: #2 alone is a target, #2 in its sentence the only exemption: ${JSON.stringify([items.exempt, shouts.exempt])}`);
          assert.equal(items.standalone, false, `${at}: a standalone button is never inside a line of text`);
        } else {
          // Under a mouse on a wide screen controls size to their words: the Items toolbar at 32px, the composer one line.
          assert.equal(items.tap, '32px', `${at}: the target is 32px under a mouse`);
          assert.ok(items.toolbar.views.length === 2 && [...items.toolbar.views, items.toolbar.filter, items.toolbar.go].every((h) => Math.abs(h - 32) <= 1), `${at}: the Items toolbar's controls are 32px: ${JSON.stringify(items.toolbar)}`);
          assert.ok(shouts.composer.text <= 34 && Math.abs(shouts.composer.send - 32) <= 1, `${at}: the composer is one line of text: ${JSON.stringify(shouts.composer)}`);
          assert.ok(items.status.length > 0 && items.status.every((h) => h <= 30), `${at}: the status bar keeps its thin strip, no exception needed: ${JSON.stringify(items.status)}`);
          assert.ok(items.short.length > 0, `${at}: there is no blanket 44px minimum under a mouse`);
        }
      }
    }

    // Under touch on the same wide screen, every action is a 44px target again, the status bar's parts included.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await chrome.waitFor("innerWidth === 1280 && matchMedia('(pointer: coarse)').matches");
    await tab('items');
    const touchItems = await audit();
    await tab('shouts');
    await openShoutConversation(chrome, 'item:2');
    const touchShouts = await audit();
    assert.equal(touchItems.tap, '44px', 'under touch the target is 44px');
    for (const [name, r] of [['Items', touchItems], ['Shouts', touchShouts]]) assert.deepEqual(r.short, [], `touch ${name}: every action at least 44px high: ${JSON.stringify(r.short)}`);
    assert.ok(touchItems.status.every((h) => h >= 44), `touch: the status bar's parts are 44px: ${JSON.stringify(touchItems.status)}`);
    // In native ascending message order, the named references retain their sizes: #2 alone is a 44px target; only the #2 inside the shout's sentence, in a
    // line of its words, is exempt. The same check refuses a standalone button.
    assert.deepEqual([touchItems.exempt, touchShouts.exempt.map((e) => [e.text, e.inLine, e.height >= 44])], [[], [['#2', true, false], ['#2', false, true]]], `touch: #2 alone is a target, #2 in its sentence the only exemption: ${JSON.stringify([touchItems.exempt, touchShouts.exempt])}`);
    assert.equal(touchItems.standalone, false, `touch: a standalone button is never inside a line of text`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('no view source file is over the 1500-line cap [C7,D1]', async () => {
  // The file-size check counts every source file in the repo; this test owns the view's source files (#745). The
  // view's tests under test/cockpit are kept whole and unchanged, so they are not counted here.
  const { fileSizeProblems } = await import('../../../../packages/gate/src/io/file/size.js');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const viewLane = /^(?:src\/cockpit\.js|src\/serve\.js|src\/view\.css|src\/view\/)/u;
  const over = fileSizeProblems(root).filter((problem) => viewLane.test(problem.path)).map((problem) => `${problem.path}:${problem.line}`);
  assert.deepEqual(over, [], 'every view file is under the 1500-line cap, so the file-size check prints no block for it');
});


test('phone tab labels keep their two pixel inset under real wide fonts [N26]', { timeout: 120_000 }, async t => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome for the tab label geometry proof.');
  const box = machine();
  project(box, 'tab-inset');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-tab-inset-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project && document.querySelectorAll("#tabs .tab").length === 8');
    for (const [width, font] of [[375, 'system-ui, sans-serif'], [375, 'Verdana, "DejaVu Sans", sans-serif'],
      [320, 'Verdana, "DejaVu Sans", sans-serif'], [305, 'Verdana, "DejaVu Sans", sans-serif'], [1280, 'system-ui, sans-serif']]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.stable(`document.documentElement.style.setProperty('--sans', ${JSON.stringify(font)})`);
      await chrome.waitFor(`innerWidth === ${width}`);
      const bar = await tabBar(chrome);
      for (const layout of bar.layouts) {
        const where = `${width}/${font}/${layout.on}`;
        assert.equal(layout.tabs.length, 8, where + ': Dashboard and all retained complete labels remain');
        for (const tab of layout.tabs) assert.ok(tab.labelLeft >= tab.left + 2 && tab.labelRight <= tab.right - 2,
          `${where}: ${tab.tab} retains the original two-pixel inset: ${JSON.stringify(tab)}`);
        assert.equal(new Set(layout.tabs.map(tab => Math.round(tab.top))).size, width < 480 ? 2 : 1, where + ': the phone has two rows and desktop one');
        layout.tabs.forEach((tab, index) => { if (index) assert.ok(tab.top >= layout.tabs[index - 1].bottom - 0.5 || tab.left >= layout.tabs[index - 1].right - 0.5, where + ': tabs never overlap'); });
        assert.ok(layout.tabs[0].left >= layout.bar[0] - 0.5 && layout.tabs.at(-1).right <= layout.bar[1] + 0.5
          && layout.bar[1] <= bar.client, where + ': the whole tab bar fits the actual content width');
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'the real page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
