// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (wide-font toolbar), using the shared real-board fixtures [N26]. */

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
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
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';

/** The items toolbar at 375 behind CI's classic scrollbar with every label widened by a letter-spacing in em, so each
 *  widens by the same share of its face on every runner, whatever fonts the runner has (#445). With forcedFonts the
 *  toolbar also draws in a wide face where the machine has one; without, each label keeps its own face, which shows
 *  the widening never rested on the face. */
const wideFontToolbar = (forcedFonts) => async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the wide-font toolbar check needs Chrome');
  const box = machine();
  const longLane = 'apilonglanenameforclipping';
  const lanes = { web: { owns: ['web/'], specs: ['G'] }, [longLane]: { owns: ['api/'], specs: ['G'] } };
  const alpha = project(box, forcedFonts ? 'wide-fonts' : 'wide-spacing', SPEC, { lanes });
  await box.inProcess(alpha.repo, 'add', 'web', 'Active item', '--specs', 'G1');
  await box.inProcess(alpha.repo, 'add', longLane, 'Another item', '--specs', 'G1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-items-wide-fonts-chrome-'));
  let chrome;
  /** The toolbar's visible labels by their text's own width, measured from the glyphs, not the boxes, and the face each draws in. */
  const labels = async () => JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('.items-view-switch button, #filter-label, #new-item span')]
    .filter((e) => e.getClientRects().length).map((e) => { const r = document.createRange(); r.selectNodeContents(e); return [e.id || e.textContent.trim(), r.getBoundingClientRect().width, getComputedStyle(e).fontFamily]; }))`));
  const widths = (list) => JSON.stringify(list.map(([name, width]) => [name, Math.round(width * 100) / 100]));
  /** Sideways scroll of the toolbar and the page, and every box in the toolbar or its menu that reaches past the toolbar's inside edge. */
  const fit = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const bar = document.querySelector('.toolbar'), s = getComputedStyle(bar), r = bar.getBoundingClientRect();
    const left = r.left + parseFloat(s.borderLeftWidth), right = r.right - parseFloat(s.borderRightWidth);
    const name = (e) => e.id ? '#' + e.id : e.className ? '.' + String(e.className).split(' ')[0] : e.tagName.toLowerCase();
    const past = [...bar.querySelectorAll('*')].filter((e) => e.getClientRects().length).map((e) => [name(e), e.getBoundingClientRect()])
      .filter(([, b]) => b.left < left - 0.5 || b.right > right + 0.5).map(([n, b]) => [n, Math.round(b.left), Math.round(b.right)]);
    return { toolbar: [bar.scrollWidth, bar.clientWidth], page: [Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), innerWidth], inside: [Math.round(left), Math.round(right)], past };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelectorAll('#chain .row').length === 2");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    // CI's runners draw a classic 15px scrollbar, which the window's width counts and the page cannot use: that is
    // what put the open menu past the toolbar on every job (#442). Draw one here too.
    await chrome.stable("(() => { const sheet = document.styleSheets[0]; sheet.insertRule('html { overflow-y: scroll; }', 0); sheet.insertRule('::-webkit-scrollbar { width: 15px; }', 0); return true; })()");
    await chrome.waitFor('document.documentElement.clientWidth === 360');
    const before = await labels();
    // A letter-spacing in em on the toolbar and its menu adds the same share of each face to every letter, so the
    // widening does not hang on which fonts this machine has. On Linux CI the forced face fell back to the runner's
    // own and "New" widened only 6% (#445). The forced face, where a machine has it, widens further.
    const face = forcedFonts ? 'font-family: Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif !important; ' : '';
    await chrome.stable(`(() => { const sheet = document.styleSheets[0]; sheet.insertRule('.toolbar, .toolbar *, .filter-menu, .filter-menu * { ${face}letter-spacing: .12em !important; }', sheet.cssRules.length); return true; })()`);
    const after = await labels();
    assert.deepEqual(after.map(([name]) => name), before.map(([name]) => name), 'the same labels, widened');
    if (forcedFonts) assert.ok(after.every(([, , family]) => family.startsWith('Verdana')), `every label asks for the forced face: ${JSON.stringify(after)}`);
    else assert.deepEqual(after.map(([, , family]) => family), before.map(([, , family]) => family), 'every label keeps its own face');
    assert.ok(after.every(([, width], i) => width >= before[i][1] * 1.1), `every label is at least 10% wider: ${widths(before)} to ${widths(after)}`);
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
      for (const open of [false, true]) {
        if (open) {
          await press(chrome, "document.querySelector('#filter-toggle')");
          await chrome.waitFor("!document.querySelector('#filter-menu').hidden");
        }
        const at = `375/${scheme}/menu ${open ? 'open' : 'closed'}`;
        const measured = await fit();
        assert.ok(measured.toolbar[0] <= measured.toolbar[1] && measured.page[0] <= measured.page[1], `${at}: neither the toolbar nor the page scrolls sideways: ${JSON.stringify(measured)}`);
        assert.deepEqual(measured.past, [], `${at}: nothing reaches past the toolbar's edges (${measured.inside}): ${JSON.stringify(measured.past)}`);
        if (open) {
          await press(chrome, "document.querySelector('#detail')");
          await chrome.waitFor("document.querySelector('#filter-menu').hidden");
        }
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
};

test('the items toolbar fits at 375 with wide fonts [N26]', wideFontToolbar(true));

test('the wide-font widening holds without the forced fonts [N26]', wideFontToolbar(false));

