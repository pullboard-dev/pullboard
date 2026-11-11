// pullboard: browser
/** @pullboard-test-gui */
/** The Settings page is grouped cards of one-height rows in human units, with copyable commands, in real Chrome [O5,O6,N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SETTING_FORMS } from '../../index.js';
import { settingsContentHtml } from '../../../view/index.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

/** What the page reports about the scope on screen, measured in the browser, not read from the markup. */
const MEASURE = `(() => {
  const pane = document.querySelector('#settings-content');
  const rows = [...pane.querySelectorAll('.set')];
  const one = node => node.getClientRects().length === 1 && node.getBoundingClientRect().height < 24;
  const values = rows.map(row => row.querySelector('.val b'));
  return {
    scopes: [...pane.querySelectorAll('.settings-scopes [data-settings-scope]')].map(node => node.textContent.trim()),
    refresh: (() => { const node = pane.querySelector('[data-settings-refresh]'); return node && { text: node.textContent.trim(), ghost: node.classList.contains('ghost'), border: getComputedStyle(node).borderTopStyle }; })(),
    where: pane.querySelector('.settings-where')?.textContent.trim() ?? '',
    groups: [...pane.querySelectorAll('.set-group')].map(card => ({ name: card.querySelector('.ghead h3')?.textContent, about: card.querySelector('.ghead p')?.textContent, changed: card.querySelector('.ghead span')?.textContent,
      rows: card.querySelectorAll('.set').length, changedChips: card.querySelectorAll('.set .changed').length })),
    heights: [...new Set(rows.map(row => Math.round(row.getBoundingClientRect().height)))],
    count: rows.length,
    rows: Object.fromEntries(rows.map(row => [row.dataset.settingKey, { name: row.querySelector('.name b').textContent, mono: row.querySelector('.name .k').textContent, what: row.querySelector('.name p').textContent,
      value: row.querySelector('.val b').textContent, chip: Boolean(row.querySelector('.changed')), under: row.querySelector('.val small').textContent, copy: row.querySelector('[data-copy-command]')?.dataset.copyCommand ?? null, text: row.textContent }])),
    wrapped: values.filter(node => !one(node)).map(node => node.textContent).concat([...pane.querySelectorAll('.changed')].filter(node => !one(node)).map(node => node.textContent)),
    clipped: values.filter(node => /^[0-9]/u.test(node.textContent) && node.scrollWidth > node.clientWidth).map(node => node.textContent),
    open: Boolean(pane.querySelector('[data-settings-open]')),
    sourceCells: pane.querySelectorAll('.setting-source, table, td').length,
    overflow: document.documentElement.scrollWidth > innerWidth,
    scopeBoxes: [...pane.querySelectorAll('[data-settings-scope]')].map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height }; }),
  };
})()`;

test('Settings shows the toggle, grouped cards, one-height rows, human units, chips and copy buttons at desktop and phone widths [O5,O6,N26]', { timeout: 180_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Settings redesign proof.');
  const box = machine();
  project(box, 'seeded', undefined, { lease: '47m' });
  mkdirSync(join(box.dir, 'machine-home'), { recursive: true });
  writeFileSync(join(box.dir, 'machine-home', 'settings.json'), JSON.stringify({ gateSlots: 8, browserSlots: 8, gate: { runnerWaitMs: 900_000, memoryFloorMB: 4000, runnersFirst: true, queue: { reviewsFirst: true } } }));
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-settings-redesign-'));
  let chrome;
  try {
    const href = new URL(view.link.href); href.pathname = '/settings';
    chrome = await openSnapshotChrome(executable, href.href, profile);
    await chrome.waitFor('view.tab === "settings" && !document.querySelector("#settings-pane").hidden');
    await chrome.waitFor('document.querySelectorAll("#settings-content [data-setting-key]").length > 0');
    for (const [width, mobile] of [[1440, false], [390, true]]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
      await press(chrome, 'document.querySelector("[data-settings-scope=machine]")');
      const shown = await chrome.stable(MEASURE);
      const at = `${width}px`;
      assert.deepEqual(shown.scopes, ['This machine', 'This repo', 'This board'], at + ': the shared toggle names the three scopes');
      assert.deepEqual(shown.refresh, { text: 'Refresh', ghost: true, border: 'solid' }, at + ': Refresh is the shared button, not a browser default');
      assert.match(shown.where, /^From .*settings\.json · \d+ changed from the default$/u, at + ': one line names the file and the changed count');
      assert.equal(shown.open, false, at + ': All local boards is not in the machine scope');
      assert.equal(shown.sourceCells, 0, at + ': no per-row source or table');
      assert.deepEqual(shown.groups.slice(0, 4).map(group => group.name), ['Capacity', 'Order', 'Runners', 'Background'], at + ': machine groups in their order');
      for (const group of shown.groups) {
        assert.ok(group.name && group.about, at + ': ' + group.name + ' has a header and a line on what it controls');
        assert.equal(group.changed, group.changedChips + ' changed', at + ': ' + group.name + ' counts its changed settings');
      }
      assert.deepEqual(shown.heights, [64], at + ': every row is the same 64px');
      assert.equal(shown.overflow, false, at + ': the page fits its width');
      assert.deepEqual(shown.wrapped, [], at + ': no value or chip wraps');
      assert.deepEqual(shown.clipped, [], at + ': no number is cut off');
      const { rows } = shown;
      assert.equal(rows.gateSlots.name, 'Checks at once');
      assert.equal(rows.gateSlots.mono, 'gateSlots');
      assert.ok(rows.gateSlots.what.length > 10);
      assert.equal(rows.gateSlots.value, '8');
      assert.equal(rows.gateSlots.chip, true);
      assert.equal(rows.gateSlots.under, 'default 2');
      assert.equal(rows['gate.runnerWaitMs'].value, '15 min', at + ': milliseconds read as minutes');
      assert.equal(rows['gate.runnerWaitMs'].under, 'default 5 min');
      assert.equal(rows['gate.memoryFloorMB'].value, '4,000 MB');
      assert.equal(rows['gate.memoryFloorMB'].under, 'default none');
      assert.equal(rows['gate.queue.reviewsFirst'].value, 'on');
      assert.equal(rows['gate.queue.reviewsFirst'].under, 'default off');
      assert.equal(rows['gate.shortSlots'].chip, false);
      assert.equal(rows['gate.shortSlots'].under, 'default', at + ': an unchanged row says only default');
      assert.equal(rows.gateSlots.copy, 'pullboard settings gateSlots 8');
      assert.equal(rows['gate.runnerWaitMs'].copy, 'pullboard settings gate.runnerWaitMs 900000');
      assert.equal(rows['gate.runnersFirst'].copy, 'pullboard settings gate.runnersFirst on');
      assert.deepEqual(Object.entries(rows).filter(([, row]) => row.copy).map(([key]) => key).sort(), Object.keys(rows).filter(key => SETTING_FORMS.includes(key)).sort(), at + ': copy buttons only for settings the CLI can set');
      assert.equal(rows['view.background'].copy, null);
      for (const [key, row] of Object.entries(rows)) {
        assert.doesNotMatch(row.value, /^(?:true|false)$/u, key + ' shows on/off, not a boolean');
        assert.doesNotMatch(row.text, /(?:\/[\w.~-]+){2,}/u, key + ' carries no path');
      }
      await press(chrome, 'document.querySelector("[data-settings-scope=board]")');
      const board = await chrome.stable(MEASURE);
      assert.equal(board.open, true, at + ': All local boards sits in the board scope');
      assert.deepEqual(board.heights, [64]);
      assert.ok(board.count > 0 && board.groups.some(group => group.name === 'Relay'));
      assert.ok(board.scopeBoxes.every(box => box.left >= 0 && box.right <= width && box.height >= (mobile ? 44 : 28)), at + ': all three scopes stay reachable');
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the renderer shortens home to ~, escapes hostile text and marks only real differences [O5,O6,N26]', () => {
  const rows = [
    { scope: 'machine', key: 'name', label: '<b>x</b>', description: 'd <i>', group: 'Capacity', unit: 'text', value: '<img src=x>', default: null, source: '/Users/example/.pullboard/settings.json', origin: 'configured' },
    { scope: 'machine', key: 'gateSlots', label: 'Checks at once', description: 'How many.', group: 'Capacity', unit: 'count', cli: 'gateSlots', value: 2, default: 2, source: '/Users/example/.pullboard/settings.json', origin: 'default' },
    { scope: 'machine', key: 'gate.shortSlots', label: 'Quick', description: 'Zero.', group: 'Capacity', unit: 'count', value: 0, default: 0, source: '/Users/example/.pullboard/settings.json', origin: 'default' },
  ];
  const html = settingsContentHtml({ rows }, 'machine');
  assert.match(html, /From <code>~\/\.pullboard\/settings\.json<\/code> · 1 changed from the default/u);
  assert.doesNotMatch(html, /<img|<b>x/u);
  assert.match(html, /&lt;img src=x&gt;/u);
  assert.equal((html.match(/class="changed"/gu) || []).length, 1);
  assert.equal((html.match(/data-copy-command/gu) || []).length, 1);
  assert.match(html, /<b title="0">0<\/b>/u, 'zero stays visible');
});

test('the renderer shows what the API row says: changing an inventory description or label changes the rendered row [O5,O6,N26]', () => {
  const base = { scope: 'machine', key: 'gateSlots', label: 'Checks at once', description: 'First wording.', group: 'Capacity', unit: 'count', cli: 'gateSlots', value: 2, default: 2, source: '/x/settings.json' };
  const first = settingsContentHtml({ rows: [base] }, 'machine');
  const second = settingsContentHtml({ rows: [{ ...base, label: 'Parallel runs', description: 'Second wording.', group: 'Order' }] }, 'machine');
  assert.match(first, /First wording\./u);
  assert.match(second, /Second wording\./u);
  assert.doesNotMatch(second, /First wording|Checks at once|Capacity/u, 'no description, label or group is held inside the view');
  assert.match(second, /Parallel runs/u);
  assert.match(second, /<h3>Order/u);
  assert.doesNotMatch(settingsContentHtml({ rows: [{ ...base, cli: null }] }, 'machine'), /data-copy-command/u, 'the copy button follows the row\'s own cli flag');
});
