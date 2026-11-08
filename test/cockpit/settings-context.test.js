// pullboard: browser
/** @pullboard-test-gui */
/** Settings stay scoped to their API authority, even before the first board [O5,O6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { machine, project, startView, openPage, fetchLive, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

test('machine Settings remain reachable without any boards and use only the global read API [O5,O6,N26]', async () => {
  const box = machine();
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const reply = await fetchLive(`${view.base}/settings`, { headers: { 'x-pullboard-key': view.key } });
    assert.equal(reply.status, 200, 'the Settings address survives a browser reload');
    await page.click({ settingsOpen: '' });
    assert.match(page.show('settings-content'), /This machine/u);
    assert.match(page.show('settings-content'), /gateSlots/u);
    assert.ok(page.requests.some(request => request.path === '/api/v1/settings'));
    assert.ok(page.requests.every(request => request.method === 'GET'));
  } finally { await view.stop(); }
});

test('global Settings distinguish repos and never reuse another selected board inventory [O5,O6,N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', undefined, { lease: '47m' });
  const beta = project(box, 'beta', undefined, { lease: '53m' });
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ root: alpha.repo });
    await page.click({ tab: 'settings' });
    await page.click({ settingsScope: 'repo' });
    assert.match(page.show('settings-content'), /47m/u);
    assert.doesNotMatch(page.show('settings-content'), /53m/u);
    await page.click({ root: beta.repo });
    await page.click({ tab: 'settings' });
    assert.match(page.show('settings-content'), /53m/u);
    assert.doesNotMatch(page.show('settings-content'), /47m/u);
    await page.click({ settingsScope: 'board' });
    await page.click({ settingsOpen: '' });
    await page.click({ settingsScope: 'repo' });
    assert.match(page.show('settings-content'), /47m/u);
    assert.match(page.show('settings-content'), /53m/u);
    assert.ok(page.requests.every(request => request.method === 'GET'));
  } finally { await view.stop(); }
});


test('Settings render hostile values as read-only text in a narrow real browser [O5,O6,N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Chrome is required for the actual Settings browser proof.');
  const box = machine();
  project(box, 'alpha', undefined, { name: '<img src=x onerror="document.body.textContent=\'settings-owned\'">' });
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'settings-chrome'));
    await chrome.waitFor('document.body.classList.contains("loading") === false');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
    await chrome.click(`document.querySelector('#proj-switch')`);
    await chrome.click(`document.querySelector('[data-tab="settings"]')`);
    await chrome.waitFor('document.querySelectorAll("#settings-content .set[data-setting-key]").length > 0');
    await chrome.click(`document.querySelector('[data-settings-scope="repo"]')`);
    await chrome.waitFor('document.querySelector("#settings-content").textContent.includes("settings-owned")');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
    const seen = JSON.parse(await chrome.stable(`JSON.stringify({ text: document.querySelector('#settings-content').textContent, images: document.querySelectorAll('#settings-content img').length, editors: document.querySelectorAll('#settings-content input,#settings-content select,#settings-content textarea,#settings-content form').length, width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, pane: getComputedStyle(document.querySelector('#settings-pane')).display })`));
    assert.match(seen.text, /<img src=x/u, 'the actual browser displays literal hostile text');
    assert.equal(seen.images, 0);
    assert.equal(seen.editors, 0);
    assert.notEqual(seen.pane, 'none');
    assert.ok(seen.width <= seen.client, `Settings do not make the phone page scroll sideways: ${seen.width}/${seen.client}`);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
