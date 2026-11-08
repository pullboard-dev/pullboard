// pullboard: browser
/** @pullboard-test-gui */
/** Settings are projected by the real local API, never read or changed by the page [O5,O6,N26]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine, project, startView, openPage, fetchLive, boardId, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

/** Escape the expected literal API text, independently of the page's renderer. */
function text(value) {
  const display = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
  return display.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

test('the Settings page lists every setting by scope from the settings API and edits nothing [O5,O6,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', undefined, { name: '<img src=x onerror="document.body.textContent=\'settings-owned\'">', lease: '47m', health: { sentinel: false }, claim: { reopenFirstRefusalMinutes: 0 } });
  project(box, 'beta', undefined, { lease: '53m' });
  box.env.PULLBOARD_RELAY_KEY = 'settings-page-private-fixture-key';
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const id = await boardId(view, alpha.repo);
    const url = new URL('/api/v1/settings', view.base);
        url.searchParams.set('board', id);
    const reply = await fetchLive(url, { headers: { 'x-pullboard-key': view.key } });
    assert.equal(reply.status, 200);
    const inventory = await reply.json();
    const before = box.run(alpha.repo, 'export', '--json');
    const config = readFileSync(join(alpha.repo, 'pullboard.json'), 'utf8');
    assert.match(page.html, /data-tab="settings"[^>]*>Settings</u, 'Settings is reachable from the board navigation');
    await page.click({ root: alpha.repo });
    await page.click({ tab: 'settings' });
    for (const scope of ['machine', 'repo', 'board']) {
      await page.click({ settingsScope: scope });
      const shown = page.show('settings-content');
      const rows = inventory.settings.filter(row => row.scope === scope);
      assert.ok(rows.length > 0, `real API has ${scope} settings`);
      assert.equal((shown.match(/data-setting-key=/gu) || []).length, rows.length, 'every API setting appears once in its scope');
      for (const row of rows) {
        assert.ok(shown.includes(`data-setting-key="${row.key}"`), `${scope}: ${row.key}`);
        const start = shown.indexOf(`data-setting-key="${row.key}"`);
        const rendered = shown.slice(start, shown.indexOf('data-setting-key=', start + 1) < 0 ? undefined : shown.indexOf('data-setting-key=', start + 1));
        const exact = row.value !== null && typeof row.value === 'object' ? JSON.stringify(row.value) : String(row.value ?? '');
        assert.ok(rendered.includes('title="' + text(exact) + '"'), `the exact current value stays on hover: ${row.key}`);
        assert.ok(row.label && row.description, `the API row carries its label and description: ${row.key}`);
      }
      assert.doesNotMatch(shown, /<(?:input|select|textarea|form)\b/u, 'settings have no editor');
      assert.doesNotMatch(shown, /settings-page-private-fixture-key/u);
      if (scope === 'repo') {
        assert.match(shown, /47m/u);
        assert.match(shown, />off</u, 'false reads as off');
        assert.match(shown, />0 min</u, 'zero remains visible, with its unit');
        assert.match(shown, /&lt;img/u, 'hostile setting text is escaped');
        assert.doesNotMatch(shown, /<img\b|<script\b/u, 'API strings never become executable markup');
      }
      if (scope === 'board') assert.match(shown, />set</u);
    }
    assert.ok(page.requests.some(request => request.path.startsWith('/api/v1/settings?board=')), 'page reads the settings API');
    assert.ok(page.requests.every(request => request.method === 'GET'), 'navigation records no moves or setting writes');
    assert.equal(readFileSync(join(alpha.repo, 'pullboard.json'), 'utf8'), config);
    assert.equal(box.run(alpha.repo, 'export', '--json'), before, 'settings navigation changes no board data');
  } finally { await view.stop(); }
});


test('Settings has a bottom sidebar address and isolates a bad row at desktop and 320px [O5,O6,N26]', { timeout: 180_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for Settings reachability and row isolation.');
  const box = machine();
  const alpha = project(box, 'healthy-settings', undefined, { submitGate: 'landing', submitDeferAbove: 20, lease: '47m' });
  const beta = project(box, 'bad-settings', undefined, { submitGate: 'landing', submitDeferAbove: 20 });
  const file = join(beta.repo, 'pullboard.json');
  const configured = JSON.parse(readFileSync(file, 'utf8'));
  configured.submitDeferAbove = 'not a number';
  writeFileSync(file, JSON.stringify(configured));
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-settings-'));
  let chrome;
  try {
    const href = new URL(view.link.href); href.pathname = '/settings';
    chrome = await openSnapshotChrome(executable, href.href, profile);
    await chrome.waitFor('view.tab === "settings" && !document.querySelector("#settings-pane").hidden');
    const footer = await chrome.stable(`(() => {
      const button = document.querySelector('#side [data-tab="settings"]');
      return { bottom: button?.closest('.side-footer') === document.querySelector('#side').lastElementChild,
        github: Boolean(button?.parentElement.querySelector('a[href*="github.com"]')),
        top: Boolean(document.querySelector('.side-body [data-tab="settings"]')) };
    })()`);
    assert.deepEqual(footer, { bottom: true, github: true, top: false });
    await press(chrome, 'document.querySelector("[data-settings-scope=board]")');
    await press(chrome, 'document.querySelector("#settings-pane [data-settings-open]")');
    await press(chrome, 'document.querySelector("[data-settings-scope=repo]")');
    await chrome.waitFor('document.querySelectorAll("#settings-content [data-setting-key]").length > 0');
    for (const [width, mobile] of [[1440, false], [320, true]]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
      const shown = await chrome.stable(`(() => {
        const rows = [...document.querySelectorAll('#settings-content [data-setting-key]')];
        return { descriptions: rows.map(row => row.querySelector('.setting-description, .setting-error')?.textContent.trim()),
          thresholds: rows.filter(row => row.dataset.settingKey === 'submitDeferAbove').map(row => ({ text: row.textContent, error: Boolean(row.querySelector('.setting-error')) })),
          healthy: rows.some(row => row.dataset.settingKey === 'lease' && row.textContent.includes('47m')),
          overflow: document.documentElement.scrollWidth > innerWidth };
      })()`);
      assert.ok(shown.descriptions.every(Boolean), width + ': each setting explains its effect');
      assert.equal(shown.thresholds.length, 2, 'both real registered repos remain visible');
      assert.ok(shown.thresholds.some(row => !row.error && row.text.includes('20')), 'the valid numeric threshold stays valid');
      assert.ok(shown.thresholds.some(row => row.error && /whole number at least 1/u.test(row.text)), 'the one bad row includes its real API repair');
      assert.ok(shown.healthy, 'an unrelated configured row survives');
      assert.equal(shown.overflow, false, width + ': the settings page fits its viewport');
      for (const scope of ['machine', 'board', 'repo']) {
        await press(chrome, 'document.querySelector("[data-settings-scope=' + scope + ']")');
        const switcher = await chrome.stable(`(() => {
          const track = document.querySelector('#settings-content .settings-scopes');
          const bounds = track.getBoundingClientRect();
          const buttons = [...track.querySelectorAll('button')];
          const selected = buttons.filter(button => button.getAttribute('aria-selected') === 'true');
          const active = selected[0], style = active && getComputedStyle(active);
          return {
            fits: buttons.every(button => {
              const box = button.getBoundingClientRect();
              return box.top >= bounds.top && box.bottom <= bounds.bottom && box.left >= bounds.left && box.right <= bounds.right;
            }),
            selectedPill: selected.length === 1 && active.dataset.settingsScope === '${scope}' &&
              style.fontWeight === '600' && style.boxShadow !== 'none' &&
              buttons.filter(button => button !== active).every(button => getComputedStyle(button).backgroundColor !== style.backgroundColor)
          };
        })()`);
        assert.deepEqual(switcher, { fits: true, selectedPill: true }, width + ': ' + scope + ' fits its track and shows the selected pill');
      }
      const provenance = await chrome.stable(`(() => {
        const rows = [...document.querySelectorAll('#settings-content [data-setting-key]')];
        return { sources: rows.map(row => ({ cell: Boolean(row.querySelector('.setting-source')), root: row.querySelector('.setting-root')?.textContent })),
          errors: rows.flatMap(row => [...row.querySelectorAll('.setting-error')].map(node => ({ edge: getComputedStyle(node).borderLeftWidth, fill: getComputedStyle(node).backgroundColor }))) };
      })()`);
      assert.ok(provenance.sources.every(source => !source.cell && !source.root?.includes('/')), 'no row carries a source or a path; all-boards rows name their board only');
      assert.ok(provenance.errors.length > 0 && provenance.errors.every(error => error.edge === '0px' && error.fill === 'rgba(0, 0, 0, 0)'), 'a bad setting uses plain error words without an edge bar or tinted box');
      if (width === 1440) {
        const geometry = await chrome.stable(`(() => { const row = document.querySelector('#settings-content .set'); return { rowHeight: row.getBoundingClientRect().height }; })()`);
        assert.equal(geometry.rowHeight, 64, 'every scalar setting is one fixed-height row');
      }
      if (width === 320) {
        const scopes = await chrome.stable(`[...document.querySelectorAll('[data-settings-scope]')].map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height }; })`);
        assert.equal(scopes.length, 3);
        assert.ok(scopes.every(box => box.left >= 0 && box.right <= width && box.height >= 44), 'all three scopes remain reachable by touch at 320px');

        await press(chrome, 'document.querySelector("#proj-switch")');
        const target = await chrome.stable(`(() => { const node = document.querySelector('#side [data-tab="settings"]'), box = node.getBoundingClientRect(); return { visible: getComputedStyle(node.parentElement).display !== 'none', left: box.left, right: box.right, height: box.height, bottom: box.bottom }; })()`);
        assert.ok(target.visible && target.left >= 0 && target.right <= width && target.height >= 44 && target.bottom <= 900, 'the bottom Settings entry is reachable by touch at 320px');
        await press(chrome, 'document.querySelector("#proj-switch")');
      }
      if (process.env.PULLBOARD_SETTINGS_SCREENSHOTS) {
        mkdirSync(process.env.PULLBOARD_SETTINGS_SCREENSHOTS, { recursive: true });
        await chrome.stable('window.scrollTo(0, 0)');
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(process.env.PULLBOARD_SETTINGS_SCREENSHOTS, 'settings-' + width + '.png'), Buffer.from(shot.data, 'base64'));
        for (const [name, invalid] of [['valid', false], ['bad', true]]) {
          await chrome.stable(`[...document.querySelectorAll('[data-setting-key="submitDeferAbove"]')].find(row => row.classList.contains('setting-invalid') === ${invalid}).scrollIntoView({ block: 'center' })`);
          const focused = await chrome.send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(join(process.env.PULLBOARD_SETTINGS_SCREENSHOTS, 'settings-' + width + '-' + name + '.png'), Buffer.from(focused.data, 'base64'));
        }
      }

    }
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).submitDeferAbove, 'not a number', 'read-only navigation never repairs configuration');
    assert.equal(JSON.parse(readFileSync(join(alpha.repo, 'pullboard.json'), 'utf8')).submitDeferAbove, 20);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
