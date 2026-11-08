// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-loads src/cli/view-state.js src/api.js src/cli.js src/next-step-words.js */
import { viewApiPorts } from '../../apps/view/index.js';
/** Cockpit projects checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { copyPackageFiles } from '../../packages/runners/index.js';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { tapTarget, SPEC, machine, project, build, sendBack, fetchLive, startView, styleOf, element, openPage, projectRows, productEntries, accept, boardId, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

test('missing-board rows stay on one line and Forget targets only the still-missing board [N26,N33,N36]', { timeout: 180_000 }, async () => {
  // budget: real Git/registry setup and a live Chrome journey, not a throughput claim.
  const executable = chromeExecutable();
  assert.ok(executable, 'the compact missing-board journey requires real Chrome');
  const box = machine();
  const healthy = project(box, 'healthy-project', SPEC, { name: 'Healthy project' });
  const missing = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(name => project(box,
    'temporary-checkout-with-a-very-long-middle-component-and-a-meaningful-project-' + name,
    SPEC, { name: 'Missing ' + name }));
  const recoveredConfig = readFileSync(join(missing[1].repo, 'pullboard.json'));
  const view = await startView(box);
  let chrome;
  const headers = { 'x-pullboard-key': view.key, 'content-type': 'application/json' };
  /** Read the current native registry, never the page's cached warning list. */
  const listing = async () => (await fetchLive(view.base + '/api/v1/boards', { headers })).json();
  /** Exercise the authenticated native action without supplying any filesystem path. */
  const forget = body => fetchLive(view.base + '/api/v1/projects/forget-unreadable', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  /** Select exactly one rendered native row by its root, without choosing the bulk control. */
  const rowButton = root => 'document.querySelector(' + JSON.stringify('[data-forget-unreadable=' + JSON.stringify(root) + ']') + ')';
  try {
    for (const project of missing) writeFileSync(join(project.repo, 'pullboard.json'), '{invalid json');
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'missing-projects-chrome'));
    await chrome.waitFor('data?.projects?.filter(project => project.warningCode === "BOARD_UNAVAILABLE").length === 4');
    assert.equal(await chrome.stable('compactProjectPath("/Users/alex/Code/project")'), '~/Code/project');
    assert.equal(await chrome.stable('compactProjectPath("/home/alex/Code/project")'), '~/Code/project');
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      if (await chrome.stable('getComputedStyle(document.querySelector("#side .side-body")).display === "none"')) await chrome.click('document.querySelector("#proj-switch")');
      if (await chrome.stable('!document.querySelector(".unreadable-projects").open')) await chrome.click('document.querySelector(".unreadable-projects summary")');
      const seen = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const section = document.querySelector('.unreadable-projects');
        return { pageFits: document.documentElement.scrollWidth <= innerWidth,
          rows: [...section.querySelectorAll('li')].map(row => {
            const copy = row.querySelector('.unreadable-copy'), name = copy.querySelector('b'), path = copy.querySelector('code');
            /** Ellipsis may add a second rectangle on the same line; count distinct actual line bands. */
            const lineCount = node => {
              const range = document.createRange();
              range.selectNodeContents(node);
              return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top * 2))).size;
            };
            const textLines = [...copy.children].map(lineCount);
            return { name: name.textContent, path: path.textContent, full: copy.title, textLines, nowrap: getComputedStyle(copy).whiteSpace,
              weight: Number(getComputedStyle(name).fontWeight), width: copy.getBoundingClientRect().width, pathWidth: path.getBoundingClientRect().width,
              fits: row.scrollWidth <= row.clientWidth, forget: row.querySelector('button')?.textContent };
          }), buttons: [...section.querySelectorAll('button')].map(button => ({ text: button.textContent, styled: button.classList.contains('ghost'), radius: parseFloat(getComputedStyle(button).borderRadius) })) };
      })())`));
      assert.equal(seen.pageFits, true, width + ': no sideways page scroll');
      assert.equal(seen.rows.length, missing.length);
      assert.deepEqual(seen.rows.map(row => row.full).sort(), missing.map(project => project.repo).sort(), 'every native missing root retains its exact tooltip');
      for (const row of seen.rows) {
        const index = missing.findIndex(project => project.repo === row.full);
        assert.equal(row.name, 'Missing ' + ['Alpha', 'Beta', 'Gamma', 'Delta'][index]);
        assert.ok(row.path.length < row.full.length && row.path.includes('…'), 'long middles are elided');
        assert.deepEqual(row.textLines, [1, 1], width + ': name and path each occupy one line');
        assert.equal(row.nowrap, 'nowrap');
        assert.ok(row.fits && row.width > 0 && row.pathWidth > 0 && row.weight <= 400, width + ': compact muted names and paths fit their row');
        assert.equal(row.forget, 'Forget');
      }
      assert.deepEqual(seen.buttons.map(button => button.text), ['Forget all', 'Forget', 'Forget', 'Forget', 'Forget']);
      assert.ok(seen.buttons.every(button => button.styled && button.radius > 0), 'all forget controls use the existing styled buttons');
    }
    const unknown = createHash('sha256').update('not a registered board').digest('hex');
    assert.equal((await forget({ confirm: true, board: unknown })).status, 400);
    assert.equal((await forget({ confirm: true, roots: [missing[0].repo] })).status, 400, 'arbitrary project paths remain refused');
    const healthyKey = createHash('sha256').update(healthy.repo).digest('hex');
    assert.equal((await (await forget({ confirm: true, board: healthyKey })).json()).forgotten, 0, 'a readable board cannot be forgotten by this action');
    await chrome.stable('window.confirm = () => false; true');
    await chrome.click(rowButton(missing[0].repo));
    assert.equal((await listing()).warnings.length, 4, 'cancelling one row preserves the registry');
    await chrome.stable('window.confirm = () => true; true');
    await chrome.click(rowButton(missing[0].repo));
    await chrome.waitFor('data.projects.filter(project => project.warningCode === "BOARD_UNAVAILABLE").length === 3');
    assert.deepEqual((await listing()).warnings.map(project => project.root).sort(), missing.slice(1).map(project => project.repo).sort(), 'one click forgets exactly its missing board');
    writeFileSync(join(missing[1].repo, 'pullboard.json'), recoveredConfig);
    const recoveredKey = createHash('sha256').update(missing[1].repo).digest('hex');
    assert.equal((await (await forget({ confirm: true, board: recoveredKey })).json()).forgotten, 0, 'a per-row selector rechecks readability at action time');
    await chrome.stable('refresh()');
    await chrome.waitFor('data.projects.some(project => project.name === "Missing Beta" && project.ok)');
    assert.ok((await listing()).boards.some(project => project.root === missing[1].repo), 'a stale row cannot forget a recovered board');
    if (await chrome.stable('!document.querySelector(".unreadable-projects").open')) await chrome.click('document.querySelector(".unreadable-projects summary")');
    await chrome.click('document.querySelector("[data-forget-unreadable=\\"\\"]")');
    await chrome.waitFor('!document.querySelector(".unreadable-projects")');
    const final = await listing();
    assert.equal(final.warnings.length, 0);
    assert.ok(final.boards.some(project => project.root === healthy.repo));
    assert.ok(final.boards.some(project => project.root === missing[1].repo), 'bulk forgetting still preserves recovered boards');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});


test('a project switch never shows the old project\'s numbers [N26,A2]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for project switch checks.');
  const box = machine();
  const alpha = project(box, 'alpha');
  const beta = project(box, 'beta');
  box.run(alpha.repo, 'add', 'web', 'Alpha-only first item', '--specs', 'G1', '--criterion', 'shown');
  box.run(alpha.repo, 'add', 'web', 'Alpha-only second item', '--specs', 'G2', '--criterion', 'shown');
  box.run(beta.repo, 'add', 'web', 'Beta-only item', '--specs', 'G1', '--criterion', 'shown');
  let view, profile, chrome;
  /** Read only the rendered project names and visible board content, including the status counts. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify({
    names: [...document.querySelectorAll('#proj-list .pname')].map((node) => node.textContent),
    lines: [...document.querySelectorAll('#proj-list .repo small')].map((node) => node.textContent),
    name: document.querySelector('#proj-name').textContent,
    main: document.querySelector('main').innerText,
    products: document.querySelector('#products').hidden ? '' : document.querySelector('#products').innerText,
    status: document.querySelector('#status-board').innerText,
  })`));
  try {
    view = await startView(box);
    profile = mkdtempSync(join(tmpdir(), 'pullboard-project-switch-chrome-'));
    const betaId = await boardId(view, beta.repo);
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    // Hold requests before real HTTP, without replacing any SQLite state or API reply.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const nativeFetch = window.fetch.bind(window);
      const gate = window.__projectStateGate = { all: true, board: null, blocked: [] };
      gate.release = () => { gate.all = false; gate.board = null; gate.blocked.splice(0).forEach((entry) => entry.resolve()); };
      window.fetch = async (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (/^\\/api\\/v1\\/boards\\/[^/]+\\/state$/.test(path) && (gate.all || path === '/api/v1/boards/' + gate.board + '/state')) {
          await new Promise((resolve) => gate.blocked.push({ path, resolve }));
        }
        return nativeFetch(input, init);
      };
    })()` });
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor('window.__projectStateGate?.blocked.length >= 2');
    const listed = await read();
    assert.deepEqual(listed.names, ['alpha', 'beta'], 'the known project names draw before any delayed board state arrives');
    assert.deepEqual(listed.lines, ['Loading…', 'Loading…'], 'unknown counts say loading rather than inventing zeros');
    await chrome.stable('window.__projectStateGate.release()');
    await chrome.waitFor(`data?.root === ${JSON.stringify(alpha.repo)} && !document.body.classList.contains('loading')`);
    const before = await read();
    assert.match(before.main, /Alpha-only/);
    assert.match(before.status, /^2\s+items\b/u);
    assert.deepEqual(before.lines, ['2 items open', '1 item open']);

    await chrome.stable(`window.__projectStateGate.board = ${JSON.stringify(betaId)}`);
    if (await chrome.stable("getComputedStyle(document.querySelector('#side .side-body')).display === 'none'")) {
      await chrome.click("document.querySelector('#proj-switch')");
    }
    await chrome.click(`document.querySelector('#proj-list [data-root="${beta.repo}"]')`);
    await chrome.waitFor('window.__projectStateGate.blocked.length > 0');
    const pending = await read();
    assert.deepEqual(pending.names, ['alpha', 'beta'], 'the cached project list stays available during the switch');
    assert.equal(pending.name, 'beta', 'the selected project is named immediately');
    assert.match(pending.main, /Loading project…/, 'the target board has an explicit loading state');
    assert.doesNotMatch(pending.main, /Alpha-only/, 'the old board is hidden beneath the new project name');
    assert.equal(pending.status, '', 'the old item and agent counts are absent until the target state arrives');
    assert.equal(pending.products, '', 'the old project progress is absent too');
    assert.deepEqual(pending.lines, before.lines, 'cached sidebar summaries retain their own project identities');
    await chrome.stable('window.__projectStateGate.release()');
    await chrome.waitFor(`data?.root === ${JSON.stringify(beta.repo)} && !document.body.classList.contains('switching')`);
    const after = await read();
    assert.match(after.main, /Beta-only item/);
    assert.doesNotMatch(after.main, /Alpha-only|Loading project…/);
    assert.match(after.status, /^1\s+items\b/u);
    assert.deepEqual(chrome.exceptions, [], 'the delayed switch raises no uncaught exception');
  } finally {
    try {
      if (chrome) {
        await chrome.stable('window.__projectStateGate?.release()').catch(() => {});
        await closeSnapshotChrome(chrome);
      }
    } finally {
      try { if (profile) rmSync(profile, { recursive: true, force: true }); }
      finally { if (view) await view.stop(); }
    }
  }
});

test('the page never tells a person with boards to run init while the list loads [N26,H5]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for loading-state checks.');
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Alpha waiting item', '--specs', 'G1', '--criterion', 'shown');
  const empty = machine();
  let view, bare, profile, chrome;
  // What a person reads now: the page's visible text, as laid out, so a hidden card never counts.
  const told = async () => chrome.stable("(document.body.innerText.match(/No boards yet|pullboard init/g) || []).join(' | ')");
  try {
    view = await startView(box);
    bare = await startView(empty);
    profile = mkdtempSync(join(tmpdir(), 'pullboard-list-loading-chrome-'));
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    // Hold the board list and each board's state before real HTTP, so the page waits as on a loaded machine.
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const nativeFetch = window.fetch.bind(window);
      const gate = window.__listGate = { list: true, state: true, blocked: [] };
      gate.release = (kind) => { gate[kind] = false; gate.blocked.filter((entry) => entry.kind === kind).forEach((entry) => entry.resolve()); };
      window.fetch = async (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        const kind = path === '/api/v1/boards' ? 'list' : /^\\/api\\/v1\\/boards\\/[^/]+\\/state$/.test(path) ? 'state' : null;
        if (kind && gate[kind]) await new Promise((resolve) => gate.blocked.push({ kind, resolve }));
        return nativeFetch(input, init);
      };
    })()` });
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor("window.__listGate?.blocked.some((entry) => entry.kind === 'list')");
    const polls = [];
    for (let poll = 0; poll < 5; poll += 1) polls.push(await told());
    // The list answers, but no board has: the names are known and the page is still loading. A Back press redraws it.
    await chrome.stable("window.__listGate.release('list')");
    await chrome.waitFor("window.__listGate.blocked.some((entry) => entry.kind === 'state') && document.querySelector('#proj-list .pname')?.textContent === 'alpha'");
    for (let poll = 0; poll < 5; poll += 1) polls.push(await told());
    await chrome.stable("dispatchEvent(new PopStateEvent('popstate', { state: null })), true");
    for (let poll = 0; poll < 5; poll += 1) polls.push(await told());
    await chrome.stable("window.__listGate.release('state')");
    await chrome.waitFor(`data?.root === ${JSON.stringify(alpha.repo)} && !document.body.classList.contains('loading') && document.body.innerText.includes('Alpha waiting item')`);
    polls.push(await told());
    assert.deepEqual(polls.filter(Boolean), [], 'a person with a board never reads No boards yet or pullboard init while the list loads');

    // A machine truly without a board says both, once its list is known to be empty.
    await chrome.send('Page.navigate', { url: bare.link.href });
    await chrome.waitFor("window.__listGate?.blocked.some((entry) => entry.kind === 'list')");
    assert.equal(await told(), '', 'nothing about init shows before the empty list answers');
    await chrome.stable("window.__listGate.release('list')");
    await chrome.waitFor("document.body.classList.contains('boardless')");
    assert.equal(await told(), 'No boards yet | pullboard init', 'a truly empty list says No boards yet and the init step');
    assert.deepEqual(chrome.exceptions, [], 'the held list raises no uncaught exception');
  } finally {
    try {
      if (chrome) {
        await chrome.stable("window.__listGate?.release('list'), window.__listGate?.release('state')").catch(() => {});
        await closeSnapshotChrome(chrome);
      }
    } finally {
      try { if (profile) rmSync(profile, { recursive: true, force: true }); }
      finally {
        try { if (bare) await bare.stop(); }
        finally { if (view) await view.stop(); }
      }
    }
  }
});

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
    await page.click({ tab: 'items' });
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

test('unreadable boards collapse to one line with Forget all while projects group readable repos with combined needs and activity [N33, N34, N36]', async () => {
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
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, shown: getComputedStyle(e).display !== 'none' && r.width > 0 }; };
    const logo = document.querySelector('#side-toggle');
    return { width: document.documentElement.clientWidth, logo: box('#side-toggle'), side: box('.side'), top: box('.top'), main: box('main'), switcher: box('#proj-switch'), list: box('#side-body'), theme: box('#theme'), live: box('#live'),
      columns: box('.two > :first-child').width + box('#detail').width, collapsed: document.documentElement.dataset.side || '', pressed: logo.getAttribute('aria-pressed'), title: logo.title,
      listPosition: getComputedStyle(document.querySelector('#side-body')).position, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.click("document.querySelector('[data-tab=\"items\"]')");
    await chrome.waitFor('innerWidth === 1280 && !!document.querySelector("#chain .row") && !!document.querySelector("#detail h2")');
    // A classic 15px scrollbar, as Linux draws one, so every edge is measured against the content width.
    await chrome.stable("document.styleSheets[0].insertRule('html { overflow-y: scroll; }', 0); document.styleSheets[0].insertRule('::-webkit-scrollbar { width: 15px; }', 0)");
    await chrome.waitFor('document.documentElement.clientWidth === innerWidth - 15');
    const open = await read();
    assert.ok(open.side.width >= 200 && open.side.height >= 800 && !open.collapsed && open.pressed === 'false', `the sidebar starts open: ${JSON.stringify(open)}`);
    assert.ok(open.theme.right >= open.width - 16 && open.theme.top < open.top.bottom && open.live.right <= open.theme.left, `the light/dark button sits at the right end of the tab bar, clear of the live status: ${JSON.stringify(open)}`);

    await chrome.click('document.querySelector("#side-toggle")');
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

    await chrome.click('document.querySelector("#proj-switch")');
    const dropdown = await read();
    assert.ok(dropdown.list.shown && dropdown.listPosition === 'absolute' && dropdown.list.top >= dropdown.top.bottom - 0.5 && dropdown.list.right <= dropdown.width, `the switcher opens the project list as a dropdown: ${JSON.stringify(dropdown.list)}`);
    await chrome.click('document.querySelector("main")');
    assert.equal((await read()).list.shown, false, 'a click outside closes it');
    await chrome.click('document.querySelector("#proj-switch")');
    await chrome.click(`document.querySelector('#proj-list [data-root="${other.repo}"]')`);
    await chrome.waitFor(`document.querySelector('#proj-name').textContent === 'collapse-other'`);
    assert.equal((await read()).list.shown, false, 'a pick closes it and shows that project');

    await chrome.send('Page.reload');
    await chrome.waitFor('document.readyState === "complete" && !!document.querySelector("#proj-switch")');
    assert.equal((await read()).collapsed, 'collapsed', 'the choice is kept in this browser across a reload');

    await chrome.click('document.querySelector("#side-toggle")');
    await chrome.waitFor('!document.documentElement.dataset.side');
    const back = await read();
    assert.ok(back.side.width >= 200 && back.list.shown && back.pressed === 'false' && back.title === 'Collapse the project list', `the logo brings the sidebar back as it was: ${JSON.stringify(back)}`);

    await chrome.click('document.querySelector("#side-toggle")');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    const phone = await read();
    await chrome.click('document.querySelector("#side-toggle")');
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
  box.run(beta.web, 'shout', 'coordinator', 'Ship beta today?', '--decision', '--kind', 'question');
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
    const renderedMarkup = page.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '');
    assert.doesNotMatch(renderedMarkup, /init-form|init-path|Start a board|<details/,
      'the rendered page has no form or disclosure for starting a board');
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
    await page.click({ tab: 'items' });
    assert.equal(page.element('proj-name').textContent, 'fresh');
    assert.equal(page.show('add-lane'), '<option>coordinator</option><option>review</option>', 'with no lane that owns folders, new work goes to the coordinator, not to the verifiers');
    assert.equal(page.element('add-specs').placeholder, 'none yet', 'and its hint names no rows the board lacks');
    await page.click({ tab: 'spec' });
    assert.equal(page.show('spec-list'), '<div class="empty">No spec rows yet. Each requirement is one row in SPEC.md, such as G1 [draft, must] and a line; write them, or ask an agent to, and they show up here.</div>', 'the Spec tab says where rows come from');

    await page.click({ root: beta.repo });
    await page.click({ tab: 'items' });
    assert.equal(page.show('add-lane'), '<option>web</option><option>coordinator</option><option>review</option>', 'a lane that owns folders comes first, review last');
    assert.equal(page.element('add-specs').placeholder, 'G1,G2');
    await page.click({ tab: 'spec' });
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
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const arrow = document.querySelector('#proj-switch small'), svg = arrow.querySelector('svg'), s = getComputedStyle(arrow), r = svg.getBoundingClientRect();
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      shown: s.display !== 'none' && r.width > 0, size: [Math.round(r.width), Math.round(r.height)], faint: s.color === (() => { const p = document.createElement('i'); p.style.color = 'var(--ink-faint)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(),
      turn: s.transform, motion: [s.transitionDuration, s.animationName], open: document.querySelector('#proj-switch').getAttribute('aria-expanded'),
    };
  })())`));
  const click = (selector) => chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
  /** One drawn frame after a click: an arrow that animated would still be part way round. */
  const frame = () => chrome.stable('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
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
          if (await chrome.stable("document.documentElement.dataset.side === 'collapsed'")) await click('#side-toggle');
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


/** Exercise the real linked-source guard and project list using two private SQLite boards. */
test('a migration-refused project stays quiet beside a normal board [A5,A6,N26]', { timeout: 120_000 }, async () => { // budget: hang-only ceiling for private Git setup and two local servers.
  const box = machine();
  const refused = project(box, 'refused-board', SPEC, { name: 'Refused board' });
  const normal = project(box, 'normal-board', SPEC, { name: 'Normal board' });
  const missing = project(box, 'missing-board', SPEC, { name: 'Missing board' });
  writeFileSync(join(missing.repo, 'pullboard.json'), '{not valid json');
  box.run(normal.repo, 'add', 'web', 'Readable beside the refused board', '--specs', 'G1');
  const primary = join(box.dir, 'migration-cli');
  const linked = join(box.dir, 'migration-cli-linked');
  mkdirSync(primary);
  copyPackageFiles(resolve(import.meta.dirname, '../..'), primary);
  box.git(primary, 'init', '-q', '-b', 'main');
  box.git(primary, 'add', '-A');
  box.git(primary, 'commit', '-q', '-m', 'chore: retain migration fixture source');
  box.git(primary, 'worktree', 'add', '-q', '-b', 'view/future', linked, 'main');
  const boardSource = join(linked, 'src/board-schema-source.js');
  const original = readFileSync(boardSource, 'utf8');
  const future = original.replace('export const SCHEMA_VERSION = 3;', 'export const SCHEMA_VERSION = 4;');
  assert.notEqual(future, original, 'only the linked running code expects the future schema');
  writeFileSync(boardSource, future);
  const file = join(refused.repo, '.git/pullboard/board.sqlite');
  const before = createHash('sha256').update(readFileSync(file)).digest('hex');
  const ordinary = new DatabaseSync(join(normal.repo, '.git/pullboard/board.sqlite'));
  try { ordinary.exec('PRAGMA user_version = 4'); } finally { ordinary.close(); }
  /** Check the persistent shared board through a read-only connection and its exact bytes. */
  const unchanged = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3, 'refused board schema is not migrated'); }
    finally { db.close(); }
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before, 'refused board file is byte-identical');
  };
  const projection = await import(pathToFileURL(join(linked, 'src/cli/view-state.js')).href);
  assert.throws(() => projection.projectState(refused.repo), error => error.code === 'UNMERGED_SCHEMA',
    'the view projector uses the running linked-source guard');
  unchanged();
  assert.ok(projection.projectState(normal.repo).items.some(item => item.title === 'Readable beside the refused board'));
  const projects = [{ root: refused.repo, name: 'Refused board', project: '', added: '2026-01-01' },
    { root: normal.repo, name: 'Normal board', project: '', added: '2026-01-01' },
    { root: missing.repo, name: 'Missing board', project: '', added: '2026-01-01' }];
  const { serveApi } = await import(pathToFileURL(join(linked, 'src/api.js')).href);
  const { openBoard, openBoardForRead } = await import(pathToFileURL(join(linked, 'apps/lib/index.js')).href);
  const { refusalDocument } = await import(pathToFileURL(join(linked, 'src/next-step-words.js')).href);
  const { main: cliMain } = await import(pathToFileURL(join(linked, 'src/cli.js')).href);
  /** Compose the linked command with its own actual native engine. */
  const main = (argv, streams) => cliMain(argv, { ...streams,
    hookWorker: join(linked, 'apps/lib/src/shell/cli-hook-work.js'), submitHandoffWorker: join(linked, 'apps/lib/src/shell/submit-handoff-worker.js'),
    launchRelaySender: (root, env) => { void import(pathToFileURL(join(linked, 'apps/lib/index.js')).href).then(sender => sender.launchRelaySender(root, env)).catch(() => {}); },
    loadNativeBoard: () => import(pathToFileURL(join(linked, 'apps/lib/index.js')).href) });
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: { openBoard, openBoardForRead }, refusalDocument, port: 0, projects: () => projects, runCommand: main });
  /** Require the public API to retain the refusal and the healthy project together. */
  const listing = async (base, key) => {
    const reply = await fetchLive(base + '/api/v1/boards', { headers: { 'x-pullboard-key': key } });
    assert.equal(reply.status, 200, 'one refused board does not crash the listing');
    const document = await reply.json();
    assert.deepEqual(document.boards.map(board => board.root), [normal.repo], 'the readable board remains listed');
    assert.equal(document.warnings.length, 2, 'both refusals remain visible in the listing');
    const schemaWarning = document.warnings.find(warning => warning.root === refused.repo);
    const missingWarning = document.warnings.find(warning => warning.root === missing.repo);
    assert.equal(schemaWarning.error.error.code, 'UNMERGED_SCHEMA');
    assert.match(schemaWarning.error.error.message, /schema 4.*version 3.*merge.*main checkout.*throwaway board/);
    assert.equal(missingWarning.error.error.code, 'BOARD_UNAVAILABLE');
    unchanged();
  };
  try {
    const address = new URL(api.url);
    await listing(address.origin, address.searchParams.get('k'));
  } finally { await api.close(); }
  const view = await startView(box, { bin: join(linked, 'bin/pullboard.js') });
  try {
    await listing(view.base, view.key);
    const page = await openPage(view);
    const sidebar = page.show('proj-list');
    assert.match(sidebar, /class="repo-error" role="status"><b>Refused board:<\/b> this worktree expects board schema 4/,
      'the refused project has a quiet status card naming the schema refusal');
    assert.match(sidebar, /merge this code into the main checkout first, or test it against a throwaway board/,
      'the quiet card tells the person the next step');
    assert.doesNotMatch(sidebar, /class="small bad"|class="bad"|stack trace/);
    assert.match(sidebar, /<summary>1 board can no longer be found<\/summary>/,
      'only the missing board is grouped as unreadable');
    const disclosureStart = sidebar.indexOf('<details class="unreadable-projects">');
    const disclosureEnd = sidebar.indexOf('</details>', disclosureStart);
    const disclosure = sidebar.slice(disclosureStart, disclosureEnd);
    assert.match(disclosure, /<b>Missing board<\/b>/);
    assert.doesNotMatch(disclosure, /Refused board|schema 4/,
      'a schema refusal is excluded from the forget list');
    assert.match(sidebar, /data-forget-unreadable>Forget all<\/button>/);
    assert.ok(projectRows(sidebar).some(row => row.name === 'Normal board'), 'a healthy project stays beside the refusal');
    await page.click({ tab: 'items' });
    assert.match(page.show('chain'), /Readable beside the refused board/, 'the healthy project still renders its actual item');
    const forgotten = await fetchLive(`${view.base}/api/v1/projects/forget-unreadable`, {
      method: 'POST', headers: { 'x-pullboard-key': view.key, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(forgotten.status, 200);
    assert.deepEqual(await forgotten.json(), { version: 1, forgotten: 1 },
      'the confirmed action removes only the currently unavailable registration');
    const after = await fetchLive(`${view.base}/api/v1/boards`, { headers: { 'x-pullboard-key': view.key } });
    const afterListing = await after.json();
    assert.deepEqual(afterListing.boards.map(board => board.root), [normal.repo]);
    assert.deepEqual(afterListing.warnings.map(warning => [warning.root, warning.error.error.code]), [[refused.repo, 'UNMERGED_SCHEMA']],
      'the schema-blocked registration remains after forgetting the unavailable one');
    unchanged();
  } finally { await view.stop(); }
});
