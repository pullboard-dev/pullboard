// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/cost.css apps/view/src/io/doctrine.css apps/view/src/io/item/panel.css apps/view/src/io/item/rows.css */
/** @pullboard-test-gui */
/** Cockpit layout checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { sendBackWithClause } from './layout/send-back.js';
import {
  SPEC,
  machine,
  project,
  build,
  fetchLive,
  fetchPage,
  startView,
  styleOf,
  element,
  storage,
  openPage,
  accept,
  press,
} from '../../tests/fixtures/cockpit/harness.js';


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
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  sendBackWithClause(box, alpha, 1, 'no greeting yet', 'greets');
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
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
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

test('no view source file is over the 1500-line cap [C7,D1]', async () => {
  // The file-size check counts every source file in the repo; this test owns the view's source files (#745). The
  // view's tests under test/cockpit are kept whole and unchanged, so they are not counted here.
  const { fileSizeProblems } = await import('../../../../packages/gate/src/io/file/size.js');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const viewLane = /^(?:src\/cockpit\.js|src\/serve\.js|src\/view\.css|src\/view\/)/u;
  const over = fileSizeProblems(root).filter((problem) => viewLane.test(problem.path)).map((problem) => `${problem.path}:${problem.line}`);
  assert.deepEqual(over, [], 'every view file is under the 1500-line cap, so the file-size check prints no block for it');
});
