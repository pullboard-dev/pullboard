// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-loads apps/cli/src/io/view.js apps/cli/index.js */
import { viewApiPorts } from '../../../view/index.js';
/** Cockpit empty-board and migration checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SPEC } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { fetchLive } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';
import { styleOf } from '../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../tests/fixtures/cockpit/harness.js';
import { projectRows } from '../../tests/fixtures/cockpit/harness.js';
import { boardId } from '../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';

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
  await box.inProcess(fresh, 'init');
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
  await box.inProcess(normal.repo, 'add', 'web', 'Readable beside the refused board', '--specs', 'G1');
  const primary = join(box.dir, 'migration-cli');
  const linked = join(box.dir, 'migration-cli-linked');
  mkdirSync(primary);
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), primary);
  box.git(primary, 'init', '-q', '-b', 'main');
  box.git(primary, 'add', '-A');
  box.git(primary, 'commit', '-q', '-m', 'chore: retain migration fixture source');
  box.git(primary, 'worktree', 'add', '-q', '-b', 'view/future', linked, 'main');
  const boardSource = join(linked, 'packages/store/src/io/board/schema/source.js');
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
  const projection = await import(pathToFileURL(join(linked, 'apps/cli/src/io/view.js')).href);
  assert.throws(() => projection.projectState(refused.repo), error => error.code === 'UNMERGED_SCHEMA',
    'the view projector uses the running linked-source guard');
  unchanged();
  assert.ok(projection.projectState(normal.repo).items.some(item => item.title === 'Readable beside the refused board'));
  const projects = [{ root: refused.repo, name: 'Refused board', project: '', added: '2026-01-01' },
    { root: normal.repo, name: 'Normal board', project: '', added: '2026-01-01' },
    { root: missing.repo, name: 'Missing board', project: '', added: '2026-01-01' }];
  const { serveApi } = await import(pathToFileURL(join(linked, 'packages/api/index.js')).href);
  const { openBoard, openBoardForRead } = await import(pathToFileURL(join(linked, 'apps/lib/index.js')).href);
  const { refusalDocument } = await import(pathToFileURL(join(linked, 'apps/cli/index.js')).href);
  const { cli$main: cliMain } = await import(pathToFileURL(join(linked, 'apps/cli/index.js')).href);
  /** Compose the linked command with its own actual native engine. */
  const main = (argv, streams) => cliMain(argv, { ...streams,
    hookWorker: join(linked, 'apps/cli/src/io/hook/work.js'), submitHandoffWorker: join(linked, 'apps/cli/src/io/submit/handoff/worker.js'),
    launchRelaySender: (root, env) => { void import(pathToFileURL(join(linked, 'apps/cli/index.js')).href).then(sender => sender.launchRelaySender(root, env)).catch(() => {}); },
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
  const view = await startView(box, { bin: join(linked, 'apps/cli/pullboard.js') });
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
