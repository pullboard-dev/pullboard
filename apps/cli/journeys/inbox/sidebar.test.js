// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-loads apps/cli/src/io/view.js apps/cli/index.js */
/** Cockpit sidebar and tab-title checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { build } from '../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../tests/fixtures/cockpit/harness.js';
import { fetchLive } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../tests/fixtures/cockpit/harness.js';
import { projectRows } from '../../tests/fixtures/cockpit/harness.js';
import { productEntries } from '../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';

/**
 * Refresh once the board's latest change is built. The summary route answers at once from the last build and only
 * starts the build that catches up (2a42eb77d4, #6634); a full state read waits for that build, so the refresh after it
 * shows the change in the other boards' rows.
 */
async function refreshAfterBuild(page, view, root) {
  await boardOf(view, root);
  await page.run('refresh()');
}

test('unreadable boards collapse to one line with Forget all while projects group readable repos with combined needs and activity [N33, N34, N36]', async () => {
  const box = machine();
  const core = project(box, 'core', `${SPEC}- G3 [pending] Should #1 greet in French?\n`, { name: 'Core API', project: 'Atlas' });
  await box.inProcess(core.repo, 'add', 'web', 'Core target #1', '--specs', 'G1', '--criterion', 'greets');
  build(box, core, 1, 'greeting.html');
  sendBack(box, core, 1, 'the page needs a greeting');
  const web = project(box, 'web', SPEC, { name: 'Web UI', project: 'Atlas' });
  await box.inProcess(web.repo, 'add', 'web', 'Target for #1', '--specs', 'G1', '--criterion', 'has a header');
  build(box, web, 1, 'header.html');
  await box.inProcess(web.repo, 'shout', 'person', 'Ship #1 today?', '--decision');
  const standalone = project(box, 'standalone', SPEC, { name: 'Scratchpad' });
  const broken = project(box, 'broken', SPEC, { name: 'Broken repo', project: 'Atlas' });
  const brokenTwo = project(box, 'broken-two', SPEC, { name: 'Broken repo two', project: 'Atlas' });
  const brokenThree = project(box, 'broken-three', SPEC, { name: 'Broken repo three', project: 'Elsewhere' });
  const recoveredConfig = readFileSync(join(brokenThree.repo, 'pullboard.json'));
  const view = await startView(box);
  try {
    const headers = { 'x-pullboard-key': view.key };
    let response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    let state = await response.json();
    assert.deepEqual(state.boards.filter((repo) => repo.project === 'Atlas').map((repo) => repo.name), ['Core API', 'Web UI', 'Broken repo', 'Broken repo two']);
    writeFileSync(join(broken.repo, 'pullboard.json'), '{not valid json');
    writeFileSync(join(brokenTwo.repo, 'pullboard.json'), '{not valid json');
    writeFileSync(join(brokenThree.repo, 'pullboard.json'), '{not valid json');
    response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    state = await response.json();
    const unreadable = state.warnings.find((repo) => repo.root === broken.repo);
    assert.equal(state.warnings.length, 3);
    assert.equal(unreadable.error.version, 1);
    assert.equal(unreadable.error.error.code, 'BOARD_UNAVAILABLE');
    assert.match(unreadable.error.error.message, /cannot be read/);
    assert.match(unreadable.error.error.message, /pullboard forget/);
    assert.doesNotMatch(unreadable.error.error.message, /BAD_CONFIG|SyntaxError/);

    const page = await openPage(view);
    const side = page.show('proj-list');
    assert.match(side, /class="repo-group"/);
    assert.match(side, /data-root="group:Atlas"/);
    assert.match(side, /Core API/);
    assert.match(side, /Web UI/);
    assert.match(side, /Scratchpad/);
    assert.match(side, /<summary>3 boards can no longer be found<\/summary>/);
    const disclosure = side.indexOf('<details class="unreadable-projects">');
    assert.ok(disclosure >= 0, 'the path list stays collapsed until opened');
    for (const root of [broken.repo, brokenTwo.repo, brokenThree.repo]) assert.ok(!side.slice(0, disclosure).includes(root), 'paths are disclosed only in the expanded list');
    assert.match(side, /<b>Broken repo<\/b> <code>[^<]+<\/code>/);
    assert.match(side, /<b>Broken repo two<\/b> <code>[^<]+<\/code>/);
    assert.match(side, /<b>Broken repo three<\/b> <code>[^<]+<\/code>/);
    assert.doesNotMatch(side, /registered project [^<]+ cannot be read/);
    assert.match(side, /data-forget-unreadable>Forget all<\/button>/);
    assert.doesNotMatch(side, /class="small bad"|class="bad"/);

    response = await fetchLive(`${view.base}/api/v1/projects/forget-unreadable`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(response.status, 403, 'the mutation requires this view session key');
    response = await fetchLive(`${view.base}/api/v1/projects/forget-unreadable`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, roots: [broken.repo] }),
    });
    assert.equal(response.status, 400, 'the browser cannot choose project roots');

    page.run('globalThis.__forgetConfirmCalls = 0; globalThis.confirm = () => { globalThis.__forgetConfirmCalls++; return false; }');
    await page.click({ forgetUnreadable: '' });
    assert.equal(page.run('globalThis.__forgetConfirmCalls'), 1);
    assert.equal(page.requests.filter((request) => request.path === '/api/v1/projects/forget-unreadable').length, 0, 'cancel leaves the registry unchanged');

    // A stale disclosure cannot forget a board that became readable after the page listed it.
    writeFileSync(join(brokenThree.repo, 'pullboard.json'), recoveredConfig);
    page.run('globalThis.confirm = () => { globalThis.__forgetConfirmCalls++; return true; }');
    await page.click({ forgetUnreadable: '' });
    assert.equal(page.run('globalThis.__forgetConfirmCalls'), 2);
    assert.ok(page.requests.some((request) => request.path === '/api/v1/projects/forget-unreadable' && request.method === 'POST' && request.body?.confirm === true));
    assert.ok(page.requests.filter((request) => request.path === '/api/v1/projects/forget-unreadable').every((request) => Object.keys(request.body).length === 1), 'the browser sends confirmation, never project paths');
    assert.doesNotMatch(page.show('proj-list'), /unreadable-projects|<b>Broken repo<\/b>|<b>Broken repo two<\/b>/);
    assert.match(page.show('proj-list'), /Broken repo three/);
    response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    state = await response.json();
    assert.equal(state.warnings.length, 0);
    assert.ok(state.boards.some((repo) => repo.root === brokenThree.repo && repo.name === 'Broken repo three'));
    assert.ok(state.boards.some((repo) => repo.root === core.repo), 'healthy registered boards are preserved');

    await page.click({ root: 'group:Atlas' });
    assert.equal(page.element('group-view').hidden, false);
    assert.equal(page.element('tabs').hidden, true);
    assert.match(page.show('group-needs'), /Core API/);
    assert.match(page.show('group-needs'), /Web UI/);
    assert.match(page.show('group-needs'), /<b>Core API<\/b><code>G3<\/code><span>Should <a class="ref" href="\/Core%20API\/items\/1" data-go="item:1" data-board="[^"]+" title="Core target #1">#1<\/a> greet in French\?<\/span><button data-root="[^"]+" type="button"><em>answer G3 →<\/em><\/button>/, "a question in one repo's spec, in the person's words");
    assert.doesNotMatch(page.show('group-needs'), /pullboard spec answer|answer in SPEC\.md/, 'the person never gets a command or the old wording on a button (#875)');
    assert.match(page.show('group-needs'), /<b>Web UI<\/b><code>coordinator \(unknown\)<\/code><span>Ship <a class="ref" href="\/Web%20UI\/items\/1" data-go="item:1" data-board="[^"]+" title="Target for #1">#1<\/a> today\?<\/span><button data-root="[^"]+" type="button"><em>decision, /, "and a decision in another's");
    assert.doesNotMatch(page.show('group-needs'), /sent back|to verify|Greeting|Header/, "work sent back or waiting for a verdict is the agents', not the person's");
    assert.match(page.show('group-activity'), /Core API/);
    assert.match(page.show('group-activity'), /Web UI/);
    assert.match(page.show('group-activity'), /Greeting|Target/);
    const activityRefs = [...page.show('group-activity').matchAll(/<a class="ref" href="[^"]+" data-go="item:1" data-board="([^"]+)" title="([^"]+)"/g)].map((link) => [link[1], link[2]]);
    assert.ok(activityRefs.some(([root, title]) => root === core.repo && title === 'Core target #1'), 'activity links bind Core API #1 to its repo');
    assert.ok(activityRefs.some(([root, title]) => root === web.repo && title === 'Target for #1'), 'activity links bind Web UI #1 to its repo');

    assert.deepEqual([...page.show('group-needs').matchAll(/<a class="ref" href="[^"]+" data-go="item:1" data-board="([^"]+)" title="([^"]+)"/g)].map((link) => [link[1], link[2]]), [
      [core.repo, 'Core target #1'], [web.repo, 'Target for #1'],
    ], 'each duplicate #1 keeps the repo where it was written');
    page.run("view.tab = 'activity'");
    await page.click({ board: core.repo, go: 'item:1' });
    assert.equal(page.run('view.root'), core.repo, 'the Core API link opens its own repo');
    assert.equal(page.run('view.item'), 1, 'the Core API link opens its #1');
    assert.equal(page.run('view.tab'), 'items', 'the Core API link opens its item detail');
    await page.click({ root: 'group:Atlas' });
    page.run("view.tab = 'activity'");
    await page.click({ board: web.repo, go: 'item:1' });
    assert.equal(page.run('view.root'), web.repo, 'the Web UI link opens its own repo');
    assert.equal(page.run('view.item'), 1, 'the Web UI link opens its #1');
    assert.equal(page.run('view.tab'), 'items', 'the Web UI link opens its item detail');
    await page.click({ root: 'group:Atlas' });

    await page.click({ root: core.repo });
    assert.equal(page.element('group-view').hidden, true);
    assert.equal(page.element('tabs').hidden, false);
    assert.match(page.show('chain'), /Core target/);
    assert.doesNotMatch(page.show('chain'), /Header/);
    assert.ok(side.includes(`data-root="${standalone.repo}"`), 'the repo without a project stands alone');
  } finally {
    await view.stop();
  }
});

test('the project list drops from the switcher at the top left, over a full-width board [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for sidebar checks.');

  const box = machine();
  const demo = project(box, 'collapse-demo');
  const other = project(box, 'collapse-other');
  await box.inProcess(demo.repo, 'add', 'web', 'An item to show', '--specs', 'G1', '--criterion', 'shown');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-collapse-chrome-'));
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

test("the sidebar shows each product's progress [N28]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', `${SPEC}- G3 [draft, must] The page has a footer. | gate: web test\n`, { products: { 'Pages <b>': ['G1', 'G3'], Goodbyes: ['G2'] } });
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Footer', '--specs', 'G3', '--criterion', 'has a footer');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  await box.inProcess(alpha.repo, 'add', 'web', 'Header', '--specs', 'G1', '--criterion', 'has a header');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  build(box, alpha, 2, 'footer.html');
  await box.inProcess(alpha.web, 'claim', '3');
  const beta = project(box, 'beta');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.element('products').hidden, false);
    assert.deepEqual(productEntries(page.show('prod-list')), [
      { name: 'Pages &lt;b&gt;', met: '1/2', bar: 50, items: ['1 open (grey)', '1 to verify (verify)', '1 verified (verified)'] },
      { name: 'Goodbyes', met: '0/1', bar: 0, items: ['1 building (building)'] },
    ]);
    // The same numbers pullboard status prints.
    assert.deepEqual((await box.inProcess(alpha.repo, 'status')).split('\n').filter((line) => line.startsWith('product ')), [
      'product Pages <b>: 2 rows, 1 approved, 1 cited by accepted items; items 1 open, 0 building, 1 awaiting verification, 1 verified',
      'product Goodbyes: 1 rows, 1 approved, 0 cited by accepted items; items 0 open, 1 building, 0 awaiting verification, 0 verified',
    ]);
    assert.match(page.show('prod-list'), /title="2 rows in force, 1 approved, 1 cited by accepted items"/);

    await page.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(page.element('products').hidden, true, 'a project that names no products shows none');
  } finally {
    await view.stop();
  }
});
test('the tab title says what needs you [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting');
  build(box, alpha, 2, 'farewell.html');
  const beta = project(box, 'beta');
  await box.inProcess(beta.repo, 'hold', 'web', '--reason', 'G2 is changing');
  const calm = project(box, 'calm');
  const view = await startView(box);
  const nobody = await startView(machine());
  try {
    const page = await openPage(view);
    const title = () => page.run('document.title');
    assert.equal(title(), '(1) alpha · Pullboard', "the lane held in beta; alpha's work sent back or waiting for a verdict is the agents'");
    page.run(`switchTo(${JSON.stringify(calm.repo)})`);
    assert.equal(title(), '(1) calm · Pullboard', 'a switch names the project at once; the count still covers them all');
    await page.run('refresh()');
    assert.equal(title(), '(1) calm · Pullboard');

    await box.inProcess(alpha.repo, 'withdraw', '1', 'the greeting moved to the next release');
    accept(box, alpha, 2);
    await box.inProcess(beta.repo, 'hold', 'web', '--off');
    await refreshAfterBuild(page, view, beta.repo);
    assert.equal(title(), 'calm · Pullboard', 'nothing needs the person, so no count');

    assert.equal((await openPage(nobody)).run('document.title'), 'Pullboard', 'with no project to show');
  } finally {
    await view.stop();
    await nobody.stop();
  }
});
test('an open decision counts in the sidebar and the tab title [B21, B26, N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const beta = project(box, 'beta');
  await box.inProcess(beta.web, 'shout', 'coordinator', 'Ship beta today?', '--decision', '--kind', 'question');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const rows = () => projectRows(page.show('proj-list')).map((row) => [row.name, row.needs, row.line]);
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], "an agent's ask is its coordinator's to answer, so it counts for no one here");

    await box.inProcess(beta.repo, 'pass', '1', 'it changes the launch');
    await refreshAfterBuild(page, view, beta.repo);
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '1', '1 decision']], "passed up, it needs the person, from alpha too");
    assert.equal(page.run('document.title'), '(1) alpha · Pullboard');

    await box.inProcess(beta.repo, 'shout', 'person', 'And the docs?', '--decision');
    await refreshAfterBuild(page, view, beta.repo);
    assert.deepEqual(rows()[1], ['beta', '2', '2 decisions'], 'a coordinator asks the person straight out too');
    await box.inProcess(beta.repo, 'answer', '2', 'yes', '--as', 'person');
    await box.inProcess(beta.repo, 'answer', '3', 'after', '--as', 'person');
    await refreshAfterBuild(page, view, beta.repo);
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], 'answered, they need no one');
    const replies = JSON.parse(await box.inProcess(beta.web, 'inbox', '--json')).shouts.filter((shout) => shout.shout_answers === 1);
    assert.deepEqual(replies.map((shout) => [shout.shout_from, shout.shout_to, shout.shout_answers, shout.shout_text]),
      [['person', 'web-1', 1, 'Person answered #2: yes']], "the person's answer reaches the agent that asked");
    assert.equal(page.run('document.title'), 'alpha · Pullboard');
  } finally {
    await view.stop();
  }
});
