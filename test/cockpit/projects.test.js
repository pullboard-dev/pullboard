/** Cockpit projects checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tapTarget, SPEC, machine, project, build, sendBack, fetchLive, startView, styleOf, element, openPage, projectRows, productEntries, accept, boardId, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';


test('the sidebar lists every project and what needs the person [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting on the page');
  build(box, alpha, 2, 'farewell.html');
  const beta = project(box, 'beta', `${SPEC}- G3 [pending] Should the page greet in French?\n`);
  box.run(beta.repo, 'hold', 'web', '--reason', 'G3 is open');
  const gamma = project(box, 'gam<i>ma');
  box.run(gamma.repo, 'add', 'web', 'Gamma page', '--specs', 'G1', '--criterion', 'renders');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const side = page.html.slice(page.html.indexOf('<aside class="side"'), page.html.indexOf('</aside>'));
    assert.match(side, /<nav id="proj-list"/, 'the project rows sit in the sidebar');
    for (const opening of side.match(/<(aside|div|nav)\b[^>]*>/g)) assert.doesNotMatch(opening, /\bhidden\b/, `${opening} shows without opening anything`);
    const style = await styleOf(view);
    assert.match(style, /\.shell \{ display: grid; grid-template-columns: var\(--side-w\) minmax\(0, 1fr\);/, 'a sidebar column beside the main one');
    assert.match(style, /@media \(max-width: 900px\) \{[^@]*\.side-body \{ display: none;[^@]*\.side\.open \.side-body \{ display: grid; \}/, 'under 900px the list folds behind the project button');

    assert.deepEqual(projectRows(page.show('proj-list')), [
      { root: alpha.repo, name: 'alpha', needs: '', line: '1 sent back · 1 to verify', current: true },
      { root: beta.repo, name: 'beta', needs: '2', line: '1 question · 1 lane held', current: false },
      { root: gamma.repo.replace('<', '&lt;').replace('>', '&gt;'), name: 'gam&lt;i&gt;ma', needs: '', line: '1 item open', current: false },
    ]);
    assert.match(page.show('chain'), /Greeting/);

    await page.click({ root: gamma.repo, classes: 'proj side' });
    assert.deepEqual(projectRows(page.show('proj-list')).map((row) => [row.name, row.current]), [['alpha', false], ['beta', false], ['gam&lt;i&gt;ma', true]]);
    assert.match(page.show('chain'), /Gamma page/, 'the main column shows the project picked');
    assert.doesNotMatch(page.show('chain'), /Greeting/);
    assert.equal(page.element('proj-name').textContent, 'gam<i>ma');
    assert.ok(!page.html.includes('proj-elsewhere'), 'the folded button carries no count: what needs the person in each project is in the list it opens');

    await page.click({ id: 'proj-switch', classes: 'switch-btn side' });
    assert.ok(page.element('side').classList.contains('open'), 'the project button opens the list');
    assert.equal(page.element('proj-switch').getAttribute('aria-expanded'), 'true');
    await page.click({ classes: 'row' });
    assert.ok(!page.element('side').classList.contains('open'), 'a click outside the sidebar folds it again');
  } finally {
    await view.stop();
  }
});

test('projects group repos with combined needs and activity, while ungrouped and unreadable repos stay clear [N33, N34, N36]', async () => {
  const box = machine();
  const core = project(box, 'core', `${SPEC}- G3 [pending] Should #1 greet in French?\n`, { name: 'Core API', project: 'Atlas' });
  box.run(core.repo, 'add', 'web', 'Core target #1', '--specs', 'G1', '--criterion', 'greets');
  build(box, core, 1, 'greeting.html');
  sendBack(box, core, 1, 'the page needs a greeting');
  const web = project(box, 'web', SPEC, { name: 'Web UI', project: 'Atlas' });
  box.run(web.repo, 'add', 'web', 'Target for #1', '--specs', 'G1', '--criterion', 'has a header');
  build(box, web, 1, 'header.html');
  box.run(web.repo, 'shout', 'person', 'Ship #1 today?', '--decision');
  const standalone = project(box, 'standalone', SPEC, { name: 'Scratchpad' });
  const broken = project(box, 'broken', SPEC, { name: 'Broken repo', project: 'Atlas' });
  const view = await startView(box);
  try {
    const headers = { 'x-pullboard-key': view.key };
    let response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    let state = await response.json();
    assert.deepEqual(state.boards.filter((repo) => repo.project === 'Atlas').map((repo) => repo.name), ['Core API', 'Web UI', 'Broken repo']);
    writeFileSync(join(broken.repo, 'pullboard.json'), '{not valid json');
    response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    state = await response.json();
    const unreadable = state.warnings.find((repo) => repo.root === broken.repo);
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
    assert.match(side, /class="repo-error" role="status"><b>Broken repo:<\/b> registered project [^<]+ cannot be read; restore the repo or run pullboard forget/);
    assert.doesNotMatch(side, /class="small bad"|class="bad"/);

    await page.click({ root: 'group:Atlas' });
    assert.equal(page.element('group-view').hidden, false);
    assert.equal(page.element('tabs').hidden, true);
    assert.match(page.show('group-needs'), /Core API/);
    assert.match(page.show('group-needs'), /Web UI/);
    assert.match(page.show('group-needs'), /<b>Core API<\/b><code>G3<\/code><span>Should <button class="ref" data-root="[^"]+" data-go="item:1" title="Core target #1" type="button">#1<\/button> greet in French\?<\/span><button data-root="[^"]+" type="button"><em>answer in SPEC\.md →<\/em><\/button>/, "a question in one repo's spec");
    assert.match(page.show('group-needs'), /<b>Web UI<\/b><code>coordinator \(unknown\)<\/code><span>Ship <button class="ref" data-root="[^"]+" data-go="item:1" title="Target for #1" type="button">#1<\/button> today\?<\/span><button data-root="[^"]+" type="button"><em>decision, /, "and a decision in another's");
    assert.doesNotMatch(page.show('group-needs'), /sent back|to verify|Greeting|Header/, "work sent back or waiting for a verdict is the agents', not the person's");
    assert.match(page.show('group-activity'), /Core API/);
    assert.match(page.show('group-activity'), /Web UI/);
    assert.match(page.show('group-activity'), /Greeting|Target/);
    const activityRefs = [...page.show('group-activity').matchAll(/<button class="ref" data-root="([^"]+)" data-go="item:1" title="([^"]+)"/g)].map((link) => [link[1], link[2]]);
    assert.ok(activityRefs.some(([root, title]) => root === core.repo && title === 'Core target #1'), 'activity links bind Core API #1 to its repo');
    assert.ok(activityRefs.some(([root, title]) => root === web.repo && title === 'Target for #1'), 'activity links bind Web UI #1 to its repo');

    assert.deepEqual([...page.show('group-needs').matchAll(/<button class="ref" data-root="([^"]+)" data-go="item:1" title="([^"]+)"/g)].map((link) => [link[1], link[2]]), [
      [core.repo, 'Core target #1'], [web.repo, 'Target for #1'],
    ], 'each duplicate #1 keeps the repo where it was written');
    page.run("view.tab = 'activity'");
    await page.click({ root: core.repo, go: 'item:1' });
    assert.equal(page.run('view.root'), core.repo, 'the Core API link opens its own repo');
    assert.equal(page.run('view.item'), 1, 'the Core API link opens its #1');
    assert.equal(page.run('view.tab'), 'items', 'the Core API link opens its item detail');
    await page.click({ root: 'group:Atlas' });
    page.run("view.tab = 'activity'");
    await page.click({ root: web.repo, go: 'item:1' });
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

test('the project list collapses into the tab bar and stays collapsed [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for sidebar checks.');

  const box = machine();
  const demo = project(box, 'collapse-demo');
  const other = project(box, 'collapse-other');
  box.run(demo.repo, 'add', 'web', 'An item to show', '--specs', 'G1', '--criterion', 'shown');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-collapse-chrome-'));
  let chrome;
  /** Read the sidebar, the tab bar and the board's columns as the person sees them. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const box = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, shown: getComputedStyle(e).display !== 'none' && r.width > 0 }; };
    const logo = document.querySelector('#side-toggle');
    return { width: document.documentElement.clientWidth, logo: box('#side-toggle'), side: box('.side'), top: box('.top'), main: box('main'), switcher: box('#proj-switch'), list: box('#side-body'), theme: box('#theme'), live: box('#live'),
      columns: box('.two > :first-child').width + box('#detail').width, collapsed: document.documentElement.dataset.side || '', pressed: logo.getAttribute('aria-pressed'), title: logo.title,
      listPosition: getComputedStyle(document.querySelector('#side-body')).position, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1280 && !!document.querySelector("#chain .row") && !!document.querySelector("#detail h2")');
    // A classic 15px scrollbar, as Linux draws one, so every edge is measured against the content width.
    await chrome.evaluate("document.styleSheets[0].insertRule('html { overflow-y: scroll; }', 0); document.styleSheets[0].insertRule('::-webkit-scrollbar { width: 15px; }', 0)");
    await chrome.waitFor('document.documentElement.clientWidth === innerWidth - 15');
    const open = await read();
    assert.ok(open.side.width >= 200 && open.side.height >= 800 && !open.collapsed && open.pressed === 'false', `the sidebar starts open: ${JSON.stringify(open)}`);
    assert.ok(open.theme.right >= open.width - 16 && open.theme.top < open.top.bottom && open.live.right <= open.theme.left, `the light/dark button sits at the right end of the tab bar, clear of the live status: ${JSON.stringify(open)}`);

    await chrome.evaluate('document.querySelector("#side-toggle").click()');
    await chrome.waitFor('document.documentElement.dataset.side === "collapsed"');
    const collapsed = await read();
    assert.deepEqual([collapsed.pressed, collapsed.title], ['true', 'Show the project list'], 'the logo says it brings the list back');
    assert.ok(collapsed.side.height <= collapsed.top.height + 0.5 && collapsed.switcher.shown && Math.abs(collapsed.switcher.top - collapsed.top.top) < collapsed.top.height && collapsed.switcher.right <= collapsed.top.left + 0.5,
      `the sidebar is one switcher at the left of the tab bar, in its row: ${JSON.stringify(collapsed)}`);
    assert.ok(!collapsed.list.shown, 'the project list folds away until asked for');
    assert.ok(Math.abs(collapsed.logo.width - collapsed.logo.height) < 1 && collapsed.logo.height >= tapTarget(1280), `the logo alone is a square control, so its hover is a square: ${JSON.stringify(collapsed.logo)}`);
    assert.ok(collapsed.main.left <= 0.5 && collapsed.main.width >= collapsed.width - 0.5 && collapsed.columns >= open.columns + 200 && !collapsed.overflow,
      `the board takes the whole width: the list and detail gain at least 200px: ${JSON.stringify({ open: open.columns, collapsed: collapsed.columns, main: collapsed.main })}`);
    assert.ok(collapsed.theme.right >= collapsed.width - 16 && collapsed.live.right <= collapsed.theme.left, 'the light/dark button stays at the right end');

    await chrome.evaluate('document.querySelector("#proj-switch").click()');
    const dropdown = await read();
    assert.ok(dropdown.list.shown && dropdown.listPosition === 'absolute' && dropdown.list.top >= dropdown.top.bottom - 0.5 && dropdown.list.right <= dropdown.width, `the switcher opens the project list as a dropdown: ${JSON.stringify(dropdown.list)}`);
    await chrome.evaluate('document.querySelector("main").click()');
    assert.equal((await read()).list.shown, false, 'a click outside closes it');
    await chrome.evaluate('document.querySelector("#proj-switch").click()');
    await chrome.evaluate(`document.querySelector('#proj-list [data-root="${other.repo}"]').click()`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'collapse-other'`);
    assert.equal((await read()).list.shown, false, 'a pick closes it and shows that project');

    await chrome.send('Page.reload');
    await chrome.waitFor('document.readyState === "complete" && !!document.querySelector("#proj-switch")');
    assert.equal((await read()).collapsed, 'collapsed', 'the choice is kept in this browser across a reload');

    await chrome.evaluate('document.querySelector("#side-toggle").click()');
    await chrome.waitFor('!document.documentElement.dataset.side');
    const back = await read();
    assert.ok(back.side.width >= 200 && back.list.shown && back.pressed === 'false' && back.title === 'Collapse the project list', `the logo brings the sidebar back as it was: ${JSON.stringify(back)}`);

    await chrome.evaluate('document.querySelector("#side-toggle").click()');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    const phone = await read();
    await chrome.evaluate('document.querySelector("#side-toggle").click()');
    const tapped = await read();
    assert.ok(phone.switcher.shown && !phone.list.shown && phone.theme.right >= phone.width - 16 && phone.theme.top < phone.side.bottom, `a phone keeps its switcher, the light/dark button at the right of its top row: ${JSON.stringify(phone)}`);
    assert.equal(tapped.collapsed, phone.collapsed, 'on a phone the logo is only the logo');
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
  box.run(solo.repo, 'shout', 'person', 'Ship it today?', '--decision');
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
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Footer', '--specs', 'G3', '--criterion', 'has a footer');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  box.run(alpha.repo, 'add', 'web', 'Header', '--specs', 'G1', '--criterion', 'has a header');
  build(box, alpha, 1, 'greeting.html');
  accept(box, alpha, 1);
  build(box, alpha, 2, 'footer.html');
  box.run(alpha.web, 'claim', '3');
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
    assert.deepEqual(box.run(alpha.repo, 'status').split('\n').filter((line) => line.startsWith('product ')), [
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
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting');
  build(box, alpha, 2, 'farewell.html');
  const beta = project(box, 'beta');
  box.run(beta.repo, 'hold', 'web', '--reason', 'G2 is changing');
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

    box.run(alpha.repo, 'withdraw', '1', 'the greeting moved to the next release');
    accept(box, alpha, 2);
    box.run(beta.repo, 'hold', 'web', '--off');
    await page.run('refresh()');
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
  box.run(beta.web, 'shout', 'coordinator', 'Ship beta today?', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const rows = () => projectRows(page.show('proj-list')).map((row) => [row.name, row.needs, row.line]);
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], "an agent's ask is its coordinator's to answer, so it counts for no one here");

    box.run(beta.repo, 'pass', '1', 'it changes the launch');
    await page.run('refresh()');
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '1', '1 decision']], "passed up, it needs the person, from alpha too");
    assert.equal(page.run('document.title'), '(1) alpha · Pullboard');

    box.run(beta.repo, 'shout', 'person', 'And the docs?', '--decision');
    await page.run('refresh()');
    assert.deepEqual(rows()[1], ['beta', '2', '2 decisions'], 'a coordinator asks the person straight out too');
    box.run(beta.repo, 'answer', '2', 'yes', '--as', 'person');
    box.run(beta.repo, 'answer', '3', 'after', '--as', 'person');
    await page.run('refresh()');
    assert.deepEqual(rows(), [['alpha', '', 'nothing open'], ['beta', '', 'nothing open']], 'answered, they need no one');
    const replies = JSON.parse(box.run(beta.web, 'inbox', '--json')).shouts.filter((shout) => shout.shout_answers === 1);
    assert.deepEqual(replies.map((shout) => [shout.shout_from, shout.shout_to, shout.shout_answers, shout.shout_text]),
      [['person', 'web-1', 1, 'Person answered #2: yes']], "the person's answer reaches the agent that asked");
    assert.equal(page.run('document.title'), 'alpha · Pullboard');
  } finally {
    await view.stop();
  }
});
test('a machine with no board says how to start one [N26]', async () => {
  const box = machine();
  const view = await startView(box);
  try {
    const page = await openPage(view);
    const style = await styleOf(view);
    // Agents start boards, so the view offers no form for it.
    assert.doesNotMatch(page.html, /init-form|init-path|Start a board|<details/, 'no form to start a board');
    assert.doesNotMatch(style, /\.start\b/);

    const classes = (on) => ['loading', 'boardless'].filter((name) => on.run(`document.body.classList.contains('${name}')`));
    assert.deepEqual(classes(page), ['boardless'], 'with no board, the board steps aside');
    assert.match(style, /\n\.first \{ display: none;[^}]*\}\n(?:\.first [^\n]*\n)*\.boardless \.first \{ display: block; \}\n\.loading \.top, \.loading \[data-pane\], \.boardless \.top, \.boardless \[data-pane\] \{ display: none; \}\n/, 'its bar of tabs and its panes hide, and the message shows');

    // Until the first board arrives the page shows none of a board, so a slow start flashes nothing.
    assert.match(page.html, /\n<body class="loading">\n/, 'the page starts loading');
    const early = await openPage(view, { hold: true });
    assert.deepEqual(classes(early), ['loading'], 'and stays so while the first answer is on its way');
    await early.release();
    assert.deepEqual(classes(early), ['boardless'], 'then the message takes the place of the board');
    assert.match(page.html, /<main>\n {2}<section class="card-panel first">\n {4}<h2>No boards yet<\/h2>\n {4}<p>Run <code>pullboard init<\/code> in a git repo, or ask an agent to\. Its board shows up here by itself\.<\/p>\n {2}<\/section>\n/, 'the message says how a board starts');
    assert.equal(page.show('proj-list'), '<div class="empty">None yet.</div>');
    assert.equal(page.element('products').hidden, true);

    // A board started meanwhile shows up on the next refresh, with no reload.
    project(box, 'alpha');
    await page.run('refresh()');
    assert.equal(page.run("document.body.classList.contains('boardless')"), false, 'a board shows its tabs and panes');
    assert.equal(page.element('proj-name').textContent, 'alpha');
    assert.deepEqual(projectRows(page.show('proj-list')).map((row) => [row.name, row.current]), [['alpha', true]]);

    // A view that cannot be reached says so in the bar it shows, rather than show nothing at all.
    const lost = await openPage(view, { hold: true });
    await view.stop();
    await lost.release();
    assert.deepEqual(classes(lost), []);
    assert.match(lost.element('live').textContent, /^cannot reach the view: /);
  } finally {
    await view.stop();
  }
});
test('a fresh board files new work where it can be built [N26, N27]', async () => {
  const box = machine();
  // A repo set up by init alone: its only lane is review, which owns no folders, and it has no rows.
  const fresh = join(box.dir, 'fresh');
  mkdirSync(fresh);
  box.git(fresh, 'init', '-q', '-b', 'main');
  box.run(fresh, 'init');
  const beta = project(box, 'beta', SPEC, { lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: [] } } });
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.equal(page.element('proj-name').textContent, 'fresh');
    assert.equal(page.show('add-lane'), '<option>coordinator</option><option>review</option>', 'with no lane that owns folders, new work goes to the coordinator, not to the verifiers');
    assert.equal(page.element('add-specs').placeholder, 'none yet', 'and its hint names no rows the board lacks');
    assert.equal(page.show('spec-list'), '<div class="empty">No spec rows yet. Each requirement is one row in SPEC.md, such as G1 [draft, must] and a line; write them, or ask an agent to, and they show up here.</div>', 'the Spec tab says where rows come from');

    await page.click({ root: beta.repo });
    assert.equal(page.show('add-lane'), '<option>web</option><option>coordinator</option><option>review</option>', 'a lane that owns folders comes first, review last');
    assert.equal(page.element('add-specs').placeholder, 'G1,G2');
    assert.equal(page.show('spec-list'), '<div class="empty">No rows match.</div>', 'rows a filter hides are not missing');
  } finally {
    await view.stop();
  }
});
test('the view runs no init [N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const other = join(box.dir, 'other');
  mkdirSync(other);
  box.git(other, 'init', '-q', '-b', 'main');
  const view = await startView(box);
  try {
    const act = async ({ root = alpha.repo, command, args }) => {
      const id = await boardId(view, root);
      const body = command === 'release' ? { verb: 'hold', args: { lane: args.lane, off: true } } : { verb: command, args };
      const res = await fetchLive(`${view.base}/api/v1/boards/${id}/moves`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pullboard-key': view.key }, body: JSON.stringify(body) });
      return { status: res.status, ...(await res.json()) };
    };
    for (const root of [undefined, alpha.repo]) {
      const refused = await act({ root, command: 'init', args: { path: other } });
      assert.equal(refused.status, 400, 'agents start boards, not the view');
      assert.equal(refused.version, 1);
      assert.equal(refused.error.code, 'BAD_REQUEST');
    }
    assert.deepEqual(readdirSync(other), ['.git'], 'and nothing is set up at the path');
    for (const command of ['add', 'shout', 'hold', 'release']) {
      const args = { lane: 'web', title: 'x', to: 'all', text: 'x', reason: 'x' };
      const refused = await act({ root: other, command, args });
      assert.equal(refused.status, 404, `${command} runs only inside a registered board`);
      assert.equal(refused.error.code, 'NO_BOARD');
    }
    const state = await (await fetchLive(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } })).json();
    assert.deepEqual(state.boards.map((entry) => entry.name), ['alpha'], 'the machine has no new board');
    const shout = await act({ root: alpha.repo, command: 'shout', args: { to: 'all', text: 'still here' } });
    assert.equal(shout.status, 200);
    assert.equal(shout.version, 1);
    assert.equal(shout.event.event_kind, 'shout');
    assert.equal(shout.result.id, (await boardOf(view, alpha.repo)).shouts.find((entry) => entry.shout_text === 'still here').shout_id, 'the action it keeps reaches the real board');
  } finally {
    await view.stop();
  }
});

test('the project switcher\'s arrow turns with the list [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for project switcher checks.');
  const box = machine();
  project(box, 'arrow-alpha');
  project(box, 'arrow-beta');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-arrow-chrome-'));
  let chrome;
  /** The switcher's arrow as it reads: shown, its size, which way it points, and whether it animates. */
  const read = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
    const arrow = document.querySelector('#proj-switch small'), svg = arrow.querySelector('svg'), s = getComputedStyle(arrow), r = svg.getBoundingClientRect();
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      shown: s.display !== 'none' && r.width > 0, size: [Math.round(r.width), Math.round(r.height)], faint: s.color === (() => { const p = document.createElement('i'); p.style.color = 'var(--ink-faint)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(),
      turn: s.transform, motion: [s.transitionDuration, s.animationName], open: document.querySelector('#proj-switch').getAttribute('aria-expanded'),
    };
  })())`));
  const click = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  /** One drawn frame after a click: an arrow that animated would still be part way round. */
  const frame = () => chrome.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
  const DOWN = 'none', UP = 'matrix(-1, 0, 0, -1, 0, 0)';
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.projects?.length === 2 && !!document.querySelector('#proj-list .proj.repo')");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        if (width === 1280) {
          // Docked, the name opens no list, so there is no arrow; collapsed, the list drops from the name.
          if (await chrome.evaluate("document.documentElement.dataset.side === 'collapsed'")) await click('#side-toggle');
          await chrome.waitFor("document.documentElement.dataset.side !== 'collapsed'");
          assert.equal((await read()).shown, false, `${at}: docked, with no list to drop, there is no arrow`);
          await click('#side-toggle');
          await chrome.waitFor("document.documentElement.dataset.side === 'collapsed'");
        }
        const closed = await read();
        assert.ok(closed.page.scroll <= closed.page.width, `${at}: no sideways scroll`);
        assert.deepEqual([closed.shown, closed.size, closed.faint, closed.open, closed.turn], [true, [16, 16], true, 'false', DOWN], `${at}: a 16px chevron in the faint ink, pointing down while the list is closed: ${JSON.stringify(closed)}`);
        assert.deepEqual(closed.motion, ['0s', 'none'], `${at}: the arrow never animates: ${JSON.stringify(closed.motion)}`);
        // Open, it points up at once: one frame after the click it is all the way round. Closed again, down.
        await click('#proj-switch');
        await frame();
        const opened = await read();
        assert.deepEqual([opened.open, opened.turn], ['true', UP], `${at}: open, it points up at once: ${JSON.stringify(opened)}`);
        await click('#proj-switch');
        await frame();
        const shut = await read();
        assert.deepEqual([shut.open, shut.turn], ['false', DOWN], `${at}: closed again, it points down at once: ${JSON.stringify(shut)}`);
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
