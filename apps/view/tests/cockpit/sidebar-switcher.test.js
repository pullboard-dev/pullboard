// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-loads apps/cli/src/io/view.js apps/cli/index.js */
/** Cockpit project switcher and single-repo project list [N26, N33]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { SPEC } from '../../../cli/tests/fixtures/cockpit/harness.js';
import { machine } from '../../../cli/tests/fixtures/cockpit/harness.js';
import { project } from '../../../cli/tests/fixtures/cockpit/harness.js';
import { startView } from '../../../cli/tests/fixtures/cockpit/harness.js';
import { openPage } from '../../../cli/tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../cli/tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../cli/tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../cli/tests/fixtures/cockpit/harness.js';

test('the project list drops from the switcher at the top left, over a full-width board [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for sidebar checks.');

  const box = machine();
  const demo = project(box, 'collapse-demo');
  const other = project(box, 'collapse-other');
  await box.inProcess(demo.repo, 'add', 'web', 'An item to show', '--specs', 'G1', '--criterion', 'shown');
  const view = await startView(box);
  const profile = privateFixtureFiles('pullboard-collapse-chrome-').root;
  let chrome;
  /** Read the top tier, the switcher, its list and the board as the person sees them. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, shown: getComputedStyle(e).display !== 'none' && r.width > 0 }; };
    return { width: document.documentElement.clientWidth, tier: box('.top-tier'), main: box('main'), switcher: box('#proj-switch'), list: box('#side-body'), theme: box('#account-slot'),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.click("document.querySelector('[data-tab=\"items\"]')");
    await chrome.waitFor('innerWidth === 1280 && !!document.querySelector("#chain .row") && !!document.querySelector("#detail h2")');
    const closed = await read();
    assert.ok(closed.switcher.shown && closed.switcher.left < 80 && closed.switcher.top >= closed.tier.top && closed.switcher.bottom <= closed.tier.bottom, `the switcher sits top left, in the top tier: ${JSON.stringify(closed)}`);
    assert.ok(!closed.list.shown, 'the project list folds away until asked for');
    assert.ok(closed.main.left <= 0.5 && closed.main.width >= closed.width - 0.5 && !closed.overflow, `the board takes the whole width: ${JSON.stringify(closed.main)}`);
    assert.ok(closed.theme.right >= closed.width - 24 && closed.theme.top >= closed.tier.top && closed.theme.bottom <= closed.tier.bottom, 'the account slot sits at the right end of the top tier');

    await chrome.click('document.querySelector("#proj-switch")');
    assert.ok(await chrome.stable('!!document.querySelector("#proj-menu .row")') && !(await read()).list.shown, 'the switcher opens the project menu first');
    await chrome.click('document.querySelector("[data-proj-all]")');
    const dropdown = await read();
    assert.ok(dropdown.list.shown && dropdown.list.top >= dropdown.tier.bottom - 0.5 && dropdown.list.right <= dropdown.width, `the switcher opens the project list as a dropdown: ${JSON.stringify(dropdown.list)}`);
    await chrome.click('document.querySelector("#proj-switch")');
    assert.equal((await read()).list.shown, false, 'a second press closes it');
    await chrome.click('document.querySelector("#proj-switch")');
    await chrome.click('document.querySelector("main")');
    assert.equal((await read()).list.shown, false, 'a click outside closes it');
    await chrome.click('document.querySelector("#proj-switch")');
    await chrome.click('document.querySelector("[data-proj-all]")');
    await chrome.click(`document.querySelector('#proj-list [data-root="${other.repo}"]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'collapse-other'`);
    assert.equal((await read()).list.shown, false, 'a pick closes it and shows that project');

    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    const phone = await read();
    assert.ok(phone.switcher.shown && !phone.list.shown && phone.theme.right >= phone.width - 24, `a phone keeps the switcher and the account slot in its top row: ${JSON.stringify(phone)}`);
    assert.ok(!phone.overflow, 'and nothing runs off the phone');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a project with one repo shows once in the project list [N33, N26]', async () => {
  const box = machine();
  const solo = project(box, 'solo', SPEC, { name: 'Solo board', project: 'Solo' });
  await box.inProcess(solo.repo, 'shout', 'person', 'Ship it today?', '--decision');
  // The relay lists every board this way: its project is its own repository's name.
  const mirrored = project(box, 'mirrored', SPEC, { name: 'acme/site', project: 'acme/site' });
  project(box, 'core', SPEC, { name: 'Core API', project: 'Atlas' });
  project(box, 'web', SPEC, { name: 'Web UI', project: 'Atlas' });
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const side = page.show('proj-list');
    const once = (name) => side.split('<span class="pname">' + name + '</span>').length - 1;
    assert.doesNotMatch(side, /data-root="group:Solo"|data-root="group:acme\/site"/, 'a project with one repo has no group heading');
    assert.deepEqual([once('Solo board'), once('acme/site'), once('Solo')], [1, 1, 0], 'each one-repo project shows as its repo, once');
    assert.ok(side.includes(`data-root="${solo.repo}"`) && side.includes(`data-root="${mirrored.repo}"`), 'as a repo button of its own');
    assert.equal((side.match(/<span class="asks">1 decision<\/span>/g) || []).length, 1, "the lone repo's decision is counted once, not again on a heading");
    assert.match(side, /data-root="group:Atlas"/, 'two repos sharing a project still group');
    assert.deepEqual([once('Core API'), once('Web UI'), once('Atlas')], [1, 1, 1], 'under one heading');
    await page.click({ root: solo.repo });
    assert.deepEqual([page.element('group-view').hidden, page.element('tabs').hidden], [true, false], 'the lone repo opens on its own board');
  } finally {
    await view.stop();
  }
});
