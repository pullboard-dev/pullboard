// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/cost.css apps/view/src/io/doctrine.css apps/view/src/io/item/panel.css apps/view/src/io/item/rows.css */
/** @pullboard-test-gui */
/** Cockpit layout checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  startView,
  element,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';



test('the project corner and the theme read the same everywhere [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for project corner checks.');
  const box = machine();
  const alpha = project(box, 'corner-alpha', `${SPEC}- G3 [pending] Should the greeting name the visitor? | gate: review\n- G4 [draft, must] The footer links home. | gate: web test\n`);
  project(box, 'corner-beta');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1');
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
