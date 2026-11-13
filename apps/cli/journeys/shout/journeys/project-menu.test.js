// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-loads apps/cli/src/io/view.js apps/cli/index.js */
/** The project switcher's menu in a real page: boards told apart, All projects and Add a project, and a pick changing the address [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC } from '../../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';

test('the project menu lists each board with kind and fact, and choosing one changes the address [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the project menu journey.');
  const box = machine();
  const quiet = project(box, 'menu-quiet', SPEC, { name: 'Quiet board' });
  const asking = project(box, 'menu-asking', SPEC, { name: 'Asking board' });
  await box.inProcess(asking.repo, 'shout', 'person', 'Ship it today?', '--decision');
  const view = await startView(box);
  const profile = join(box.dir, 'project-menu-chrome');
  let chrome;
  /** The menu's rows as the person reads them. */
  const rows = async () => JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#proj-menu .row')].map((row) => ({
    text: row.querySelector('b').textContent, kind: row.querySelector('small').textContent, fact: row.querySelector('em').textContent,
    amber: row.querySelector('em').classList.contains('a'), current: row.classList.contains('cur'), root: row.dataset.root })))`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1440 && !!document.querySelector("#proj-switch") && data?.projects?.every((x) => !x.loading) && data.projects.length === 2');
    await chrome.click('document.querySelector("#proj-switch")');
    await chrome.waitFor('!!document.querySelector("#proj-menu .row")');
    const listed = await rows();
    const byName = Object.fromEntries(listed.map((row) => [row.text, row]));
    assert.equal(listed.length, 2);
    assert.equal(byName['Asking board'].kind, 'Local board');
    assert.deepEqual([byName['Asking board'].fact, byName['Asking board'].amber], ['1', true], 'a board with a decision shows its count in amber');
    assert.deepEqual([byName['Quiet board'].fact, byName['Quiet board'].amber], ['quiet', false]);
    assert.equal(listed.filter((row) => row.current).length, 1, 'one board is marked as the one shown');
    const foot = await chrome.stable('[...document.querySelectorAll("#proj-menu .foot button")].map((b) => b.textContent).join("|")');
    assert.equal(foot, 'All projects|Add a project…');
    await chrome.click('document.querySelector("#proj-menu [data-proj-add]")');
    assert.match(await chrome.stable('document.querySelector("#proj-menu .add-note").textContent'), /pullboard init/);
    const other = listed.find((row) => !row.current);
    const before = await chrome.stable('location.pathname + location.hash');
    await chrome.click(`document.querySelector('#proj-menu [data-root="${other.root}"]')`);
    await chrome.waitFor(`view.root === ${JSON.stringify(other.root)} && !document.querySelector('#proj-menu')`);
    const after = await chrome.stable('decodeURIComponent(location.pathname + location.hash)');
    assert.notEqual(after, before, 'choosing a board changes the page address');
    assert.ok(after.includes(other.text), `the address names the chosen board: ${after}`);
    await chrome.click('document.querySelector("#proj-switch")');
    await chrome.waitFor('!!document.querySelector("#proj-menu")');
    await chrome.click('document.querySelector("main")');
    await chrome.waitFor('!document.querySelector("#proj-menu")');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
