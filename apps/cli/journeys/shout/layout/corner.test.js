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
    const theme = document.querySelector('#account'), bar = document.querySelector('.top-tier'), side = document.querySelector('.strip');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      mode: document.documentElement.dataset.side || 'docked', logo: box(document.querySelector('#side-toggle svg')), name: box(document.querySelector('#proj-name')),
      wordmark: shown(document.querySelector('#side-toggle span')), arrow: shown(document.querySelector('#proj-switch small')),
      rows: [...document.querySelectorAll('#proj-list .proj.repo')].map((row) => {
        const s = getComputedStyle(row), asks = row.querySelector('small .asks');
        return { name: row.querySelector('.pname').textContent, line: row.querySelector('small').textContent, pill: !!row.querySelector('.need'), on: row.classList.contains('on'),
          asks: asks ? { text: asks.textContent, first: row.querySelector('small').firstElementChild === asks, warn: getComputedStyle(asks).color === warn } : null,
          tint: rgb(s.backgroundColor), edge: rgb(s.borderTopColor) };
      }),
      theme: { scheme: document.documentElement.dataset.scheme || null, box: box(theme), bar: box(bar), picked: document.documentElement.dataset.theme || null, side: box(side) },
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
        // The account control (it holds the theme row, #6648) sits centred in the top tier (the logo, the project, the theme), with the tab strip under it,
        // on a wide screen and a phone alike (#6614).
        const top = r.theme.bar;
        assert.ok(Math.abs(middle(r.theme.box) - middle(top)) <= 2 && r.theme.box.left >= top.left && r.theme.box.right <= top.right, `${at}: the account control sits centred in the top bar: ${JSON.stringify(r.theme)}`);
        assert.ok(top.top <= 0.5 && r.theme.side.top >= top.bottom - 1, `${at}: the top tier first, the tabs under it: ${JSON.stringify(r.theme)}`);
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

    // The corner is the logo, then the name, which opens the project list, so it carries its arrow (#6614).
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await frame();
    const collapsed = await read();
    assert.ok(collapsed.logo.right <= collapsed.name.left && Math.abs(middle(collapsed.logo) - middle(collapsed.name)) <= 2, `the logo, then the name, in one row: ${JSON.stringify([collapsed.logo, collapsed.name])}`);
    assert.deepEqual([collapsed.mode, collapsed.arrow], ['collapsed', true], 'the name opens a list, so it carries the arrow');

    /** Read whether the GitHub project tool is visible in its sidebar container; Settings moved to the account menu (#6648, 961749a883). */
    const footer = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const bar = document.querySelector('.side-footer'), github = bar?.querySelector('a[href]');
      const shown = (element) => { const style = element && getComputedStyle(element), rect = element?.getBoundingClientRect(); return !!element && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0; };
      return { bottomSibling: bar === document.querySelector('#side').lastElementChild && !bar.closest('#side-body'), github: shown(github), githubText: github?.textContent.trim(), footer: shown(bar) };
    })())`));
    assert.deepEqual(await footer(), { bottomSibling: true, github: false, githubText: 'GitHub ↗', footer: false }, 'collapsed, the project tool leaves the short logo row without shrinking it');
    await click('#proj-switch');
    await chrome.waitFor("!!document.querySelector('#proj-menu .row')");
    await click('[data-proj-all]');
    await chrome.waitFor("document.querySelector('#side').classList.contains('open') && getComputedStyle(document.querySelector('.side-footer')).display === 'flex'");
    assert.deepEqual(await footer(), { bottomSibling: true, github: true, githubText: 'GitHub ↗', footer: true }, 'the collapsed desktop popover exposes the project tool as a visible control');
    assert.equal(await chrome.stable(`(() => {
      const tools = document.querySelector('.side-footer').getBoundingClientRect();
      const project = document.querySelector('#proj-list .proj').getBoundingClientRect();
      return tools.bottom <= project.top && tools.right <= document.documentElement.clientWidth;
    })()`), true, 'the collapsed tool fits above the project choices without covering them');
    // Settings lives in the account menu now, and opens its pane from there.
    await click('#account');
    await chrome.waitFor("!document.querySelector('#account-menu').hidden");
    await click('#account-menu [data-tab="settings"]');
    await chrome.waitFor("document.querySelector('#settings-pane') && !document.querySelector('#settings-pane').hidden");
    assert.equal(await chrome.stable("document.querySelector('#settings-pane').hidden"), false, 'the Settings row opens its pane from the account menu');

    // The theme is a row in the account menu (#6648): it starts from the system's, each press switches light and dark,
    // the row says which the person kept, a reload keeps it; collapsed, the account control still sits centred in the top bar.
    /** The Theme row's hint, read after opening the account menu. */
    const hint = async () => {
      // The menu rebuilds as it opens and a Theme press leaves it open, so close an open one first.
      if (await chrome.stable("!document.querySelector('#account-menu').hidden")) await click('#account');
      await click('#account');
      await chrome.waitFor("!document.querySelector('#account-menu').hidden");
      return chrome.stable("document.querySelector('#account-menu [data-theme-label]').textContent");
    };
    assert.deepEqual([collapsed.theme.scheme, collapsed.theme.picked, await hint()], ['light', null, 'System'], 'none picked yet: the system\'s, light here, and the row says System');
    await click('#account');
    await chrome.waitFor("document.querySelector('#account-menu').hidden");
    // With none picked the page follows the system as it changes.
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await frame();
    await chrome.waitFor("document.documentElement.dataset.scheme === 'dark'");
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await frame();
    await chrome.waitFor("document.documentElement.dataset.scheme === 'light'");
    assert.ok(Math.abs(middle(collapsed.theme.box) - middle(collapsed.theme.bar)) <= 2, `the account control sits centred in the top bar: ${JSON.stringify(collapsed.theme)}`);
    /** Press the Theme row in the account menu, as a person does. */
    const flip = async () => {
      await hint();
      await click('#account-menu [data-theme-flip]');
      await frame();
    };
    await flip();
    assert.deepEqual([(await read()).theme.scheme, await chrome.stable("localStorage.getItem('pb.theme')")], ['dark', 'dark'], 'a press switches to dark');
    await flip();
    assert.deepEqual([(await read()).theme.scheme, await chrome.stable("localStorage.getItem('pb.theme')")], ['light', 'light'], 'the next press is light again, never back to following the system');
    await flip();
    await chrome.send('Page.reload');
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('#account')");
    assert.equal((await read()).theme.scheme, 'dark', 'presses switch between the two, and a reload keeps the last');
    assert.equal(await hint(), 'Dark', 'the row says which the person kept');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
