// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-loads apps/cli/src/io/view.js apps/cli/index.js */
/** Cockpit projects checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  build,
  sendBack,
  fetchLive,
  startView,
  styleOf,
  openPage,
  projectRows,
  boardId,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

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
    assert.equal(await chrome.stable('compactProjectPath("/Users/person/Code/project")'), '~/Code/project');
    assert.equal(await chrome.stable('compactProjectPath("/home/person/Code/project")'), '~/Code/project');
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
  await box.inProcess(alpha.repo, 'add', 'web', 'Alpha-only first item', '--specs', 'G1', '--criterion', 'shown');
  await box.inProcess(alpha.repo, 'add', 'web', 'Alpha-only second item', '--specs', 'G2', '--criterion', 'shown');
  await box.inProcess(beta.repo, 'add', 'web', 'Beta-only item', '--specs', 'G1', '--criterion', 'shown');
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
    await chrome.click(`document.querySelector('[data-tab="items"]')`); // a person opens Items before the list is drawn, since pages open on the Dashboard.
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
  await box.inProcess(alpha.repo, 'add', 'web', 'Alpha waiting item', '--specs', 'G1', '--criterion', 'shown');
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
    await chrome.click(`document.querySelector('[data-tab="items"]')`); // a person opens Items before the list is drawn, since pages open on the Dashboard.
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
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'no greeting on the page');
  build(box, alpha, 2, 'farewell.html');
  const beta = project(box, 'beta', `${SPEC}- G3 [pending] Should the page greet in French?\n`);
  await box.inProcess(beta.repo, 'hold', 'web', '--reason', 'G3 is open');
  const gamma = project(box, 'gam<i>ma');
  await box.inProcess(gamma.repo, 'add', 'web', 'Gamma page', '--specs', 'G1', '--criterion', 'renders');
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
