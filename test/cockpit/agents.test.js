/** Cockpit agents checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { closeBoard, openBoard, register } from '../../src/board.js';
import { exportBoard, importBoard } from '../../src/exchange.js';
import { exportView, projectState } from '../../src/serve.js';
import { relayClientFixture } from '../relay-client-fixture.js';
import { AGENT_SHELL_MARKERS, SSH_SHELL_MARKERS } from '../../src/person.js';
import { runFixtureChildAsync } from '../fixture-child.js';
import { startChrome } from '../relay-browser-fixture.js';
import { BIN, tapTarget, SPEC, machine, project, build, sendBack, startView, openPage, agentEntries, accept, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, earlier, shoutsAt, press, settled } from './fixture.js';


test('the agents panel says what each agent holds [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const second = join(box.dir, 'alpha-web-two');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  box.run(second, 'join', 'web');
  for (const title of ['Header', 'Farewell', 'Greeting <b>bold</b>', 'Footer']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // The board lists items newest first; each agent's rows must put its higher id second.
  build(box, alpha, 3, 'greeting.html');
  const two = { ...alpha, web: second, branch: 'web/two', baseBranch: 'web/two' };
  build(box, two, 2, 'farewell.html');
  sendBack(box, two, 2, 'no farewell on the page');
  build(box, two, 4, 'footer.html');
  box.run(alpha.web, 'claim', '1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    assert.deepEqual(agentEntries(page.show('agents')).map((agent) => agent.id), ['web-1', 'web-2'], 'an agent holding nothing waits in the idle fold, closed');
    assert.match(page.show('agents'), /<button class="fold-line" data-fold="idle" type="button" aria-expanded="false" title="coordinator \(unknown\)"><span>1 idle<\/span>/);
    page.run('view.open.idle = true; render();');
    const agents = agentEntries(page.show('agents'));
    assert.deepEqual(agents.map((agent) => [agent.id, agent.holds, agent.more, agent.idle]), [
      // An agent holding work is a row with its first thing: the claim, then work sent back, then work waiting for a verdict.
      ['web-1', ['#1 Header: building'], 1, false],
      ['web-2', ['#2 Farewell: sent back'], 1, false],
      // One holding nothing is a pill.
      ['coordinator', [], 0, true],
    ]);
    for (const agent of agents.filter((entry) => !entry.idle)) assert.match(agent.age, /^(now|\d+[mhd])$/, `${agent.id} shows when it last moved`);
    assert.deepEqual(agents.map((agent) => agent.path), [alpha.web, second, alpha.repo], 'each path is on hover');
    // Picked, an agent's row opens to every thing it holds, in that order.
    const opened = (id) => { page.run(`view.agent = ${JSON.stringify(id)}; render();`); return agentEntries(page.show('agents')).find((agent) => agent.id === id).holds; };
    assert.deepEqual(opened('web-1'), ['#1 Header: building', '#3 Greeting &lt;b&gt;bold&lt;/b&gt;: to verify']);
    assert.deepEqual(opened('web-2'), ['#2 Farewell: sent back', '#4 Footer: to verify']);
    page.run('view.agent = null; render();');
    for (const agent of agents) assert.ok(!agent.text.includes(agent.path), `${agent.id}'s path is not in the text`);

    await page.click({ go: 'item:1' });
    assert.match(page.show('detail'), /<h2><span>#1<\/span>Header<\/h2>/, 'a held item opens on the Items tab');
  } finally {
    await view.stop();
  }
});
test('the agents panel is rows for work and pills for idle [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered agent checks.');

  const box = machine();
  const alpha = project(box, 'roster');
  for (const title of ['Header', 'Footer']) box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // web-1 waits on a verdict for #2 and builds #1: two things, the claim first.
  build(box, alpha, 2, 'footer.html');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'roster-web-2'), gone = join(box.dir, 'roster-web-3');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/roster2');
  box.run(second, 'join', 'web');
  box.git(alpha.repo, 'worktree', 'add', '-q', gone, '-b', 'web/roster3');
  // web-3 joined three hours ago and has not moved since: not at work, so behind show all.
  earlier(alpha.repo, Date.now() - 3 * 36e5, (board) => assert.equal(register(board, { lane: 'web', path: gone }), 'web-3'));
  box.run(alpha.web, 'shout', 'coordinator', 'Header is under way.');
  box.run(second, 'shout', 'coordinator', 'Free when you need me.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roster-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.agents?.length >= 4 && data.project.shouts.length >= 2');
    await chrome.evaluate("document.querySelector('[data-tab=shouts]').click()");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #agents [data-agent]")');
    assert.equal(await chrome.evaluate("document.querySelectorAll('#agents .agent-pill').length + ':' + document.querySelector('#agents .fold-line[data-fold=\"idle\"]').getAttribute('aria-expanded')"), '0:false', 'the idle agents start folded');
    await chrome.evaluate("(() => { const fold = document.querySelector('.fold-line[data-fold=\"idle\"]'); if (fold && fold.getAttribute('aria-expanded') !== 'true') fold.click(); })()");
    const agents = await chrome.evaluate('data.project.agents.length');
    /** The panel as it reads: each row and pill, measured where it stands. */
    const panel = async () => JSON.parse(await chrome.evaluate(`JSON.stringify((() => {
      const box = (e) => { const r = e.getBoundingClientRect(); return { height: r.height, width: r.width }; };
      const list = document.querySelector('#agents');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        rows: [...list.querySelectorAll('.agent-card')].map((card) => {
          const row = card.querySelector('.agent-row');
          return { id: row.dataset.agent, text: row.innerText.replace(/\\s+/g, ' ').trim(), title: row.title, height: box(row).height, on: card.classList.contains('on'),
            face: getComputedStyle(row.querySelector('.avatar')).color, name: getComputedStyle(row.querySelector('.agent-who b')).color,
            work: [...card.querySelectorAll('.agent-work[data-item]')].map((work) => [work.dataset.item, box(work).height]) };
        }),
        pills: [...list.querySelectorAll('.agent-pill')].map((pill) => ({ id: pill.dataset.agent, title: pill.title, height: box(pill).height, on: pill.classList.contains('on') })),
        idle: list.querySelector('.fold-line[data-fold="idle"] span')?.textContent ?? null, all: list.querySelector('.all-agents')?.textContent ?? null, height: box(list).height,
        chip: document.querySelector('#shout-to-chip').hidden ? null : document.querySelector('#shout-to-chip').textContent, to: document.querySelector('#shout-to').value,
        cards: [...document.querySelectorAll('#feed .shout')].map((card) => [card.querySelector('.who').textContent, card.querySelector('.to').textContent.replace('→ ', '')]),
      };
    })())`));

    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await shoutsAt(chrome, width, scheme);
        const at = `${width}px ${scheme}`;
        const p = await panel();
        assert.ok(p.page.scroll <= p.page.width && p.page.body <= p.page.width, `${at}: no sideways scroll: ${JSON.stringify(p.page)}`);
        // The agent holding work is one row: avatar, name, age, its first thing with that item's state, and how many more.
        assert.deepEqual(p.rows.map((row) => row.id), ['web-1'], `${at}: only an agent holding work takes a row`);
        const [row] = p.rows;
        assert.match(row.text, /^W1 web-1 \(Test Model\) building \+1 (?:now|\d+[mhd]) #1 Header$/, `${at}: what the row says: ${row.text}`);
        assert.equal(row.face, row.name, `${at}: the name is in its avatar's colour, as in the feed`);
        assert.ok(row.height >= tapTarget(width), `${at}: the row is a target`);
        assert.ok(!/strong/.test(row.text) && row.title.includes('web · strong') && row.title.includes(alpha.web), `${at}: lane, route and path are on hover, not in the row: ${row.title}`);
        // Agents holding nothing are pills in the idle fold; one that has not moved in the last hour waits behind show all.
        assert.deepEqual([p.idle, p.pills.map((pill) => pill.id)], ['2 idle', ['coordinator', 'web-2']], `${at}: the idle agents are pills`);
        assert.ok(p.pills.every((pill) => pill.height >= tapTarget(width) && pill.title.includes(' · ')), `${at}: each pill a target with its lane on hover`);
        assert.equal(p.all, `show all ${agents}`, `${at}: every agent one click away`);
        assert.ok(p.height < 260, `${at}: four agents take little room: ${p.height}px`);
      }
    }

    // A row filters the feed to that agent and addresses the composer to it, and opens to each thing it holds.
    await shoutsAt(chrome, 1280, 'light');
    await chrome.evaluate(`document.querySelector('#agents .agent-row[data-agent="web-1"]').click()`);
    let p = await panel();
    assert.deepEqual([p.rows[0].on, p.rows[0].work.map(([id]) => id), p.chip, p.to, p.cards], [true, ['1', '2'], 'to web-1 (Test Model)×', 'web-1', [['web-1 (Test Model)', 'coordinator (unknown)']]],
      `the picked row opens to what it holds, the feed shows its shouts and the composer is addressed to it: ${JSON.stringify(p)}`);
    assert.ok(p.rows[0].work.every(([, height]) => height >= tapTarget(1280)), 'each thing it holds is a target');
    // A pill does the same.
    await chrome.evaluate(`document.querySelector('#agents .agent-pill[data-agent="web-2"]').click()`);
    p = await panel();
    assert.deepEqual([p.pills.find((pill) => pill.id === 'web-2').on, p.chip, p.cards], [true, 'to web-2 (Test Model)×', [['web-2 (Test Model)', 'coordinator (unknown)']]], 'a pill filters and addresses too');
    // And a thing an agent holds opens its item.
    await chrome.evaluate(`document.querySelector('#agents .agent-row[data-agent="web-1"]').click()`);
    await chrome.evaluate(`document.querySelector('#agents .agent-work[data-item="2"]').click()`);
    await chrome.waitFor(`!document.querySelector('[data-pane=items]').hidden && document.querySelector('#detail h2')?.textContent.includes('Footer')`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('agent model display names follow the API on phone and desktop [O8,N26]', { timeout: 150_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for model-name viewport proof');
  const box = machine();
  const alpha = project(box, 'model-names');
  const model = 'GPT-6 with a very long model declaration for readable agent names';
  box.run(alpha.web, 'join', 'web', '--model', model);
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try { register(board, { lane: 'coordinator', path: alpha.repo, model: 'Claude' }); }
  finally { closeBoard(board); }
  for (const title of ['Known holder', 'Reviewed model', 'Unknown holder']) {
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'visible');
  }
  build(box, alpha, 2, 'reviewed.txt');
  accept(box, alpha, 2);
  box.run(alpha.web, 'claim', '1');
  const unknown = join(box.dir, 'unknown-web');
  box.git(alpha.repo, 'worktree', 'add', '-q', unknown, '-b', 'web/unknown');
  // An existing stored registration may have no model even though new CLI joins require one.
  const legacyBoard = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try { register(legacyBoard, { lane: 'web', path: unknown }); }
  finally { closeBoard(legacyBoard); }
  box.run(unknown, 'claim', '3');
  box.run(alpha.web, 'shout', 'web-2', 'Known sender and unknown recipient');
  box.run(unknown, 'shout', 'all', 'Unknown sender and a lane-free recipient');
  box.run(alpha.repo, 'shout', 'person', 'A model decision', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Wait for the model decision');
  box.run(alpha.repo, 'milestone', 'add', 'Model release', '--items', '1,2,3');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-model-names-chrome-'));
  let chrome;
  /** Read rendered text from the real browser without changing its API data. */
  const text = (selector) => chrome.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
  /** Press a real control and wait until its requested pane is drawn. */
  const tab = async (name) => {
    await press(chrome, `document.querySelector('[data-tab="${name}"]')`);
    await settled(chrome, `view.tab === ${JSON.stringify(name)}`);
  };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await settled(chrome, "data?.project?.agents?.length === 3 && !!document.querySelector('#chain [data-item=\"1\"]')");
    for (const style of ['suffix', 'prefix']) {
      if (style === 'prefix') {
        const configFile = join(alpha.repo, 'pullboard.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8'));
        config.agents = { ...(config.agents || {}), names: 'prefix' };
        writeFileSync(configFile, JSON.stringify(config, null, 2));
        box.git(alpha.repo, 'add', 'pullboard.json');
        box.git(alpha.repo, 'commit', '-q', '-m', 'chore: use prefix names');
        await chrome.evaluate('refresh()');
      }
      const expected = style === 'suffix'
        ? { builder: 'web-1 (' + model + ')', reviewer: 'coordinator (Claude)', unknown: 'web-2 (unknown)' }
        : { builder: 'gpt-6-with-a-very-long-model-declaration-for-readable-agent-names-web-1', reviewer: 'claude-coordinator', unknown: 'unknown-web-2' };
      const apiNames = JSON.parse(await chrome.evaluate('JSON.stringify(Object.fromEntries(data.project.agents.map(a => [a.agent_id, a.displayName])))'));
      assert.deepEqual(apiNames, { coordinator: expected.reviewer, 'web-1': expected.builder, 'web-2': expected.unknown }, `${style}: authoritative API names`);
      for (const width of [375, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await settled(chrome, `innerWidth === ${width}`);
        const at = `${style} ${width}`;
        await tab('items');
        await press(chrome, 'document.querySelector("[data-state=active]")');
        await settled(chrome, '!!document.querySelector("#chain [data-item=\\"1\\"]")');
        assert.equal(await text('#chain [data-item="1"] .chip'), expected.builder, `${at}: item row holder`);
        assert.equal(await text('#chain [data-item="3"] .chip'), expected.unknown, `${at}: unknown model row`);
        await press(chrome, 'document.querySelector("#chain [data-item=\\"1\\"]")');
        await settled(chrome, 'view.item === 1');
        assert.ok((await text('#detail')).includes(expected.builder), `${at}: held item detail`);
        assert.equal(await text('#needs .row[data-go^="decide:"] .meta'), 'NEEDS YOU a decision, asked by ' + expected.reviewer, `${at}: Needs-you decision author`);
        assert.ok((await text('#needs .row[data-go="tab:shouts"] .meta')).includes('lane held by ' + expected.reviewer), `${at}: Needs-you lane holder`);
        await press(chrome, 'document.querySelector("[data-state=verified]")');
        await settled(chrome, '!!document.querySelector("#chain [data-item=\\"2\\"]")');
        await press(chrome, 'document.querySelector("#chain [data-item=\\"2\\"]")');
        await settled(chrome, 'view.item === 2');
        const detail = await text('#detail');
        assert.ok(detail.includes(expected.builder) && detail.includes(expected.reviewer), `${at}: builder and verifier detail`);
        assert.ok((await text('#detail .verdict .by')).startsWith(expected.reviewer), `${at}: verdict identity`);
        await tab('shouts');
        for (const [id, label] of [['web-1', expected.builder], ['web-2', expected.unknown]]) {
          assert.equal(await text(`#agents [data-agent="${id}"] .agent-who b`), label, `${at}: agent panel ${id}`);
        }
        if (!await chrome.evaluate('Boolean(view.open.idle)')) await press(chrome, 'document.querySelector("[data-fold=idle]")');
        assert.equal((await text('#agents [data-agent="coordinator"]')).trim(), expected.reviewer, `${at}: idle agent model`);
        const feed = await text('#feed');
        assert.ok(feed.includes(expected.builder) && feed.includes(expected.unknown) && feed.includes(expected.reviewer), `${at}: shout sender and recipient names`);
        assert.ok(feed.includes('→ all') && feed.includes('→ person'), `${at}: person and broadcast recipients keep their names`);
        const headers = JSON.parse(await chrome.evaluate(`JSON.stringify([...document.querySelectorAll('#feed .shout header')].map(header => {
          const rect = header.getBoundingClientRect();
          return { height: rect.height, line: parseFloat(getComputedStyle(header.querySelector('.who')).lineHeight),
            labels: [...header.querySelectorAll('.agent-label')].map(label => {
              const id = label.querySelector('.agent-id'), part = label.querySelector('.agent-model'), box = id.getBoundingClientRect();
              return { name: label.textContent, title: label.title, aria: label.getAttribute('aria-label'), id: id.textContent,
                left: box.left, right: box.right, headerLeft: rect.left, headerRight: rect.right, idWidth: id.clientWidth, idScroll: id.scrollWidth,
                ellipsis: getComputedStyle(part).textOverflow, clipped: part.scrollWidth > part.clientWidth };
            }) };
        }))`));
        assert.ok(headers.length > 0, `${at}: real shout headers render`);
        const accessible = await chrome.send('Accessibility.getFullAXTree');
        const names = accessible.nodes.filter(node => node.role?.value === 'group' && !node.ignored).map(node => node.name?.value);
        assert.ok(names.includes(expected.builder) && names.includes(expected.unknown) && names.includes(expected.reviewer), `${at}: Chrome exposes complete model names to assistive readers`);

        for (const header of headers) {
          assert.ok(header.height <= header.line + 1, `${at}: shout identity stays on one line: ${JSON.stringify(header)}`);
          for (const label of header.labels) {
            assert.equal(label.title, apiNames[label.id], `${at}: full API name stays in the tooltip`);
            assert.equal(label.aria, apiNames[label.id], `${at}: full API name stays accessible`);
            assert.equal(label.idWidth, label.idScroll, `${at}: the address is never clipped`);
            assert.ok(label.left >= label.headerLeft - 1 && label.right <= label.headerRight + 1, `${at}: address stays inside its header`);
          }
        }
        if (width === 375) assert.ok(headers.flatMap(h => h.labels).some(label => label.id === 'web-1' && label.clipped && label.ellipsis === 'ellipsis'), `${at}: only the long model shortens with an ellipsis`);

        await press(chrome, 'document.querySelector("#agents [data-agent=\\"web-1\\"]")');
        await settled(chrome, 'view.agent === "web-1"');
        assert.equal(await chrome.evaluate('view.agent'), 'web-1', `${at}: filtering retains the raw API id`);
        await press(chrome, 'document.querySelector("[data-agent=\\"\\"]")');
        await tab('activity');
        const activity = await text('#activity');
        assert.ok(activity.includes(expected.builder) && activity.includes(expected.unknown) && activity.includes(expected.reviewer), `${at}: activity identities`);
        await tab('roadmap');
        assert.doesNotMatch(await text('#roadmap'), /web-[12]|coordinator/, `${at}: roadmap rows name no agents`);
        await press(chrome, 'document.querySelector("#roadmap [data-go=\\"item:1\\"]")');
        await settled(chrome, 'view.tab === "items" && view.item === 1');
        assert.ok((await text('#detail')).includes(expected.builder), `${at}: roadmap item opens with the API identity`);
        assert.ok(await chrome.evaluate('document.documentElement.scrollWidth <= innerWidth'), `${at}: no sideways overflow`);
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'all model-name views run without browser exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('staged and exported boards carry API model display names [O8,N26,A10]', async () => {
  const box = machine();
  const alpha = project(box, 'model-export', SPEC, { agents: { names: 'prefix' } });
  box.run(alpha.web, 'join', 'web', '--model', 'GPT-6');
  const source = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  const staged = openBoard(join(box.dir, 'staged-models.sqlite'));
  try {
    const before = exportBoard(source);
    importBoard(staged, before);
    const ordinary = projectState(alpha.repo);
    const borrowed = projectState(alpha.repo, { board: staged });
    assert.equal(ordinary.agents.find(a => a.agent_id === 'web-1').displayName, 'gpt-6-web-1', 'ordinary projector respects configured API name');
    assert.equal(borrowed.agents.find(a => a.agent_id === 'web-1').displayName, 'gpt-6-web-1', 'staged projector carries the same name');
    const directory = join(box.dir, 'exported-models');
    await exportView(alpha.repo, directory);
    const boardIds = readdirSync(join(directory, 'api', 'v1', 'boards'));
    assert.equal(boardIds.length, 1, 'the export contains the real fixture board');
    const snapshot = JSON.parse(readFileSync(join(directory, 'api', 'v1', 'boards', boardIds[0], 'state.json'), 'utf8'));
    assert.equal(snapshot.state.agents.find(a => a.agent_id === 'web-1').displayName, 'gpt-6-web-1', 'snapshot API retains the configured model name');
    assert.deepEqual(exportBoard(source), before, 'presentation does not change the real source board');
    assert.equal(staged.db.prepare('SELECT 1 AS open').get().open, 1, 'the borrowed file-backed board stays open');
  } finally {
    closeBoard(staged);
    closeBoard(source);
  }
});

test('local agents panel inventories and phone-revokes a scoped credential [H2,H9,H16,B26,N26]', { timeout: 180_000 }, async (t) => {
  assert.ok(chromeExecutable(), 'this security proof requires actual Chrome');
  const box = await relayClientFixture(t);
  const personEnv = { ...box.env };
  for (const key of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete personEnv[key];
  const privateBin = box.env.PATH.split(delimiter)[0];
  /** Quote a private fixture executable path literally for its hook shim. */
  const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(privateBin, 'pullboard'), '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' ' + shellQuote(BIN) + ' "$@"\n', { mode: 0o700 });
  execFileSync('git', ['add', '-A'], { cwd: box.root, env: personEnv, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'test: prepare private credential view'], { cwd: box.root, env: personEnv, stdio: 'pipe' });
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const setup = spawn(process.execPath, [BIN, 'relay', 'on', '--all', '--url', box.origin, '--json'], {
    cwd: box.root, env: personEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let setupOutput = '';
  setup.stdout.setEncoding('utf8').on('data', chunk => { setupOutput += chunk; });
  setup.stderr.resume();
  const setupDone = new Promise((resolve, reject) => setup.once('close', (code, signal) => {
    if (signal) return reject(new Error('private foreground pairing was interrupted'));
    try { resolve({ code, document: JSON.parse(setupOutput) }); }
    catch { reject(new Error('private foreground pairing returned no JSON')); }
  }));
  t.after(async () => { if (setup.exitCode === null) setup.kill('SIGTERM'); await setupDone.catch(() => {}); });
  /** Poll persisted private fixture state without retrying an operation. */
  const waitFixture = async (read, message, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    do { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
    assert.fail(message);
  };
  const pending = await waitFixture(() => existsSync(machineFile) && JSON.parse(readFileSync(machineFile, 'utf8')).pending,
    'foreground pairing publishes the one-use device enrollment');
  const phone = await box.phoneSession();
  const phoneChrome = await startChrome();
  t.after(() => phoneChrome.close());
  const localChrome = await startChrome();
  t.after(() => localChrome.close());
  assert.equal((await phoneChrome.send('Network.setCookie', {
    name: 'pb_session', value: phone.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true);
  await phoneChrome.navigate(`${box.origin}/#device=${pending.locator}.${pending.secret}`);
  assert.equal((await setupDone).code, 0, 'the real phone session pairs the machine');
  await phoneChrome.waitFor("document.querySelector('#phone-approvals') !== null");

  const joined = await box.cli('worktree', box.lane);
  assert.equal(joined.code, 0, joined.failure ?? 'a real agent worktree joins with machine credentials');
  const agentRoot = joined.document.path;
  const agentId = joined.document.agent;
  const other = await box.cli('worktree', box.lane);
  assert.equal(other.code, 0, other.failure ?? 'a second agent receives its own credential');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const oldPA = link.agentTokens[agentId], otherPA = link.agentTokens[other.document.agent];
  assert.match(oldPA.token, /^pa_[A-Za-z0-9_-]{43}$/u);
  const listed = await box.cli('relay', 'tokens');
  assert.equal(listed.code, 0, listed.failure ?? 'the real CLI reads token metadata');
  const expected = listed.document.tokens.find(row => row.agent === agentId);
  assert.ok(expected?.id && expected.created && expected.expires);
  assert.deepEqual(listed.document.tokens.map(row => row.agent).sort(), [agentId, other.document.agent].sort(), 'both independent agent credentials are listed');
  assert.equal(JSON.stringify(listed.document).includes(oldPA.token), false, 'the native inventory contains no PA value');

  const view = await startView({ dir: box.root, env: personEnv });
  try {
    await localChrome.navigate(view.link.href);
    await localChrome.waitFor("typeof data === 'object' && !!data?.project");
    /** Deliver actual mouse input only after layout settles and the target is uncovered. */
    const tap = async (selector) => {
      await localChrome.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width)`);
      const point = JSON.parse(await localChrome.evaluate(`(async () => {
        const find=()=>document.querySelector(${JSON.stringify(selector)}); const e=find();
        e.scrollIntoView({block:'center',inline:'nearest'});
        const frame=()=>new Promise(done=>requestAnimationFrame(()=>done())); let previous='', stable=0;
        for(let i=0;i<120&&stable<2;i++){await frame();const n=find(),r=n?.getBoundingClientRect(),v=r?[r.x,r.y,r.width,r.height,scrollX,scrollY].join():'';stable=v&&v===previous?stable+1:0;previous=v;}
        const n=find(),r=n?.getBoundingClientRect(); if(!n||!r||r.width<=0||r.height<=0)throw Error('control is not laid out');
        const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
        if(hit!==n&&!n.contains(hit))throw Error('the real mouse point is covered by another control');
        return JSON.stringify({x,y});
      })()`));
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await localChrome.send('Input.dispatchMouseEvent', {
        type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
      });
    };
    await tap('[data-tab="shouts"]');
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      await localChrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await localChrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await localChrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      if (!await localChrome.evaluate('Boolean(document.querySelector("[data-token-id]"))')) await tap('[data-credentials]');
      for (const metadata of listed.document.tokens) {
        const selector = `[data-token-id="${metadata.id}"]`;
        await localChrome.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
        const row = JSON.parse(await localChrome.evaluate(`JSON.stringify((() => {
          const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
          return {id:e.dataset.tokenId,text:e.innerText,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
            rowOverflow:r.right>document.documentElement.clientWidth};
        })())`));
        assert.equal(row.id, metadata.id);
        for (const value of [metadata.id, metadata.agent, new Date(metadata.created).toISOString(), new Date(metadata.expires).toISOString()]) {
          assert.ok(row.text.includes(value), `${width}/${scheme}: the row shows token id, agent and ISO creation/expiry`);
        }
        assert.equal(row.text.includes(oldPA.token), false, 'the credential value never enters the DOM');
        for (const secret of [oldPA.token, otherPA.token, link.token, phone.token, readFileSync(box.keyFile, 'utf8').trim()]) {
          assert.equal(await localChrome.evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(secret)}) || JSON.stringify(data).includes(${JSON.stringify(secret)}) || JSON.stringify([...credentials]).includes(${JSON.stringify(secret)})`), false,
            'the local page, projected board and inventory retain no credential value or board key');
        }
        assert.equal(await localChrome.evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector('[data-revoke-token]').getBoundingClientRect().height >= 44`), true,
          `${width}/${scheme}: revocation has a full touch target`);

        assert.equal(row.overflow || row.rowOverflow, false, `${width}/${scheme}: the inventory stays within the viewport`);
      }
    }

    const authorizationsBefore = box.calls.filter(call => call.path.endsWith('/authorize')).length;
    await tap(`[data-revoke-token="${expected.id}"]`);
    await localChrome.waitFor("document.querySelector('#credentials [role=status]')?.textContent.includes('Approve revocation on your phone…')");
    assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, authorizationsBefore,
      'the local button waits for a person and has not silently authorized revocation');

    // A separate paired-phone browser completes the actual pending native grant with real mouse input.
    const encodedKey = readFileSync(box.keyFile, 'utf8').trim();
    const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
    await phoneChrome.navigate(`${box.origin}/#board=${board}&key=${encodedKey}`);
    await phoneChrome.waitFor("document.querySelector('#phone-approvals') !== null");
    await phoneChrome.waitFor(` [...document.querySelectorAll('.phone-approval')].some(node => node.textContent.includes(${JSON.stringify(expected.id)}))`);
    const approvalPoint = JSON.parse(await phoneChrome.evaluate(`(() => {
      const card=[...document.querySelectorAll('.phone-approval')].find(node=>node.textContent.includes(${JSON.stringify(expected.id)}));
      const button=card?.querySelector('button'); button?.scrollIntoView({block:'center',behavior:'instant'});
      const r=button?.getBoundingClientRect(); if(!r||r.width<=0||r.height<=0)throw Error('approval button is not visible');
      const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
      if(hit!==button&&!button.contains(hit))throw Error('approval mouse point is covered'); return JSON.stringify({x,y});
    })()`));
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await phoneChrome.send('Input.dispatchMouseEvent', {
      type, ...approvalPoint, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    });
    await localChrome.waitFor("document.querySelector('#credentials [role=status]')?.textContent.includes('Credential revoked.')");
    assert.equal(await localChrome.evaluate(`document.querySelector('[data-token-id="${expected.id}"]')?.textContent.includes('Revoked')`), true, 'the acknowledged credential row is marked revoked');
    assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, authorizationsBefore + 1,
      'one real phone tap authorizes exactly one revoke');

    const mintsBefore = box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length;
    const stale = await runFixtureChildAsync(process.execPath, [BIN, 'add', box.lane, 'must refuse revoked scoped credential', '--json'], {
      cwd: agentRoot, encoding: 'utf8', env: {
        ...personEnv, PULLBOARD_RELAY_TOKEN: oldPA.token, AI_AGENT: '1', CODEX_SHELL: '1',
        CODEX_THREAD_ID: 'private-credential-inventory',
      },
    });
    assert.equal(stale.status, 1);
    assert.equal(JSON.parse(stale.stdout).error.code, 'AUTH_REQUIRED', 'the old PA refuses its very next native move');
    assert.equal(box.calls.filter(call => call.method === 'POST' && call.path === '/auth/tokens').length, mintsBefore, 'the refused explicit credential is never silently replaced');
    const unaffected = await runFixtureChildAsync(process.execPath, [BIN, 'shout', 'coordinator', 'the other credential still works', '--json'], {
      cwd: other.document.path, env: { ...personEnv, PULLBOARD_RELAY_TOKEN: otherPA.token, AI_AGENT: '1', CODEX_SHELL: '1', CODEX_THREAD_ID: 'private-credential-inventory-other' },
    });
    assert.equal(unaffected.status, 0, 'revoking one credential leaves the other agent able to move');
  } finally {
    await localChrome.close();
    await phoneChrome.close();
    await view.stop();
  }
});
