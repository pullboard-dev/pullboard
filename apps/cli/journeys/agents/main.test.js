// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit agents checks, using the shared real-board fixtures [N26]. */
import { main as nativeTestMain } from '../../tests/fixtures/native.js';
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
} from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  closeBoard,
  register,
} from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { projectState } from '../../src/io/view.js';
import { exportView } from '../../src/io/commands/view.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  AGENT_SHELL_MARKERS,
  SSH_SHELL_MARKERS,
} from '../../../../packages/kernel/index.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { startChrome } from '../../tests/fixtures/relay/browser.js';
import { stableChrome } from '../../tests/fixtures/cockpit/stable.js';
import {
  BIN,
  tapTarget,
  SPEC,
  machine,
  project,
  build,
  sendBack,
  startView,
  openPage,
  agentEntries,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  earlier,
  shoutsAt,
  press,
  settled,
  chooseFilter,
} from '../../tests/fixtures/cockpit/harness.js';


/** Open the actual native thread before checking its full messages and agent filter. */
async function openConversation(chrome, key = 'none') {
  if (await chrome.stable("!!document.querySelector('#feed .conversation-heading')")) {
    await press(chrome, "document.querySelector('#feed [data-shout-thread=\"\"]')");
  }
  const selector = '#feed [data-shout-thread="' + key + '"]';
  await chrome.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  await chrome.waitFor("!!document.querySelector('#feed .conversation-heading')");
}

test('the agents panel says what each agent holds [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  const second = join(box.dir, 'alpha-web-two');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  await box.inProcess(second, 'join', 'web', '--route', 'strong');
  for (const title of ['Header', 'Farewell', 'Greeting <b>bold</b>', 'Footer']) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // The board lists items newest first; each agent's rows must put its higher id second.
  build(box, alpha, 3, 'greeting.html');
  const two = { ...alpha, web: second, branch: 'web/two', baseBranch: 'web/two' };
  build(box, two, 2, 'farewell.html');
  sendBack(box, two, 2, 'no farewell on the page');
  build(box, two, 4, 'footer.html');
  await box.inProcess(alpha.web, 'claim', '1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'shouts' });
    assert.deepEqual(agentEntries(page.show('agents')).map((agent) => agent.id), ['web-1', 'web-2'], 'an agent holding nothing waits in the idle fold, closed');
    assert.match(page.show('agents'), /<button class="fold-line" data-fold="idle" type="button" aria-expanded="false" title="coordinator"><span>1 idle<\/span>/);
    page.run('view.open.idle = true; render();');
    const agents = agentEntries(page.show('agents'));
    assert.deepEqual(agents.map((agent) => [agent.id, agent.holds, agent.more, agent.idle]), [
      // An agent holding work is a row with its first thing: the claim, then work sent back, then work waiting for a verdict.
      ['web-1', ['#1 Header: Building'], 1, false],
      ['web-2', ['#2 Farewell: Ready · Sent back'], 1, false],
      // One holding nothing is a pill.
      ['coordinator', [], 0, true],
    ]);
    for (const agent of agents.filter((entry) => !entry.idle)) assert.match(agent.age, /^(now|\d+[mhd])$/, `${agent.id} shows when it last moved`);
    assert.deepEqual(agents.map((agent) => agent.path), [alpha.web, second, alpha.repo], 'each path is on hover');
    // Picked, an agent's row opens to every thing it holds, in that order.
    const opened = (id) => { page.run(`view.agent = ${JSON.stringify(id)}; render();`); return agentEntries(page.show('agents')).find((agent) => agent.id === id).holds; };
    assert.deepEqual(opened('web-1'), ['#1 Header: Building', '#3 Greeting &lt;b&gt;bold&lt;/b&gt;: In review']);
    assert.deepEqual(opened('web-2'), ['#2 Farewell: Ready · Sent back', '#4 Footer: In review']);
    page.run('view.agent = null; render();');
    for (const agent of agents) assert.ok(!agent.text.includes(agent.path), `${agent.id}'s path is not in the text`);

    await page.click({ go: 'item:1' });
    assert.match(page.show('detail'), /<h2><span class="id">#1<\/span>Header<\/h2>/, 'a held item opens on the Items tab');
  } finally {
    await view.stop();
  }
});
test('the agents panel is rows for work and pills for idle [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered agent checks.');

  const box = machine();
  const alpha = project(box, 'roster');
  for (const title of ['Header', 'Footer']) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  // web-1 waits on a verdict for #2 and builds #1: two things, the claim first.
  build(box, alpha, 2, 'footer.html');
  await box.inProcess(alpha.web, 'claim', '1');
  const second = join(box.dir, 'roster-web-2'), gone = join(box.dir, 'roster-web-3');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/roster2');
  await box.inProcess(second, 'join', 'web');
  box.git(alpha.repo, 'worktree', 'add', '-q', gone, '-b', 'web/roster3');
  // web-3 joined three hours ago and has not moved since: not at work, so behind show all.
  earlier(alpha.repo, Date.now() - 3 * 36e5, (board) => assert.equal(register(board, { lane: 'web', path: gone }), 'web-3'));
  await box.inProcess(alpha.web, 'shout', 'all', 'Header is under way.');
  await box.inProcess(second, 'shout', 'all', 'Free when you need me.');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roster-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.agents?.length >= 4 && data.project.shouts.length >= 2');
    await chrome.click("document.querySelector('[data-tab=shouts]')");
    await chrome.waitFor('document.querySelector("[data-pane=shouts]:not([hidden]) #agents [data-agent]")');
    await openConversation(chrome);
    assert.equal(await chrome.stable("document.querySelectorAll('#agents .agent-pill').length + ':' + document.querySelector('#agents .fold-line[data-fold=\"idle\"]').getAttribute('aria-expanded')"), '0:false', 'the idle agents start folded');
    await chrome.stable("(document.querySelector('.fold-line[data-fold=\"idle\"]'))?.getAttribute('aria-expanded') !== 'true' && !!(document.querySelector('.fold-line[data-fold=\"idle\"]'))").then(open => open ? chrome.click("document.querySelector('.fold-line[data-fold=\"idle\"]')") : undefined);
    const agents = await chrome.stable('data.project.agents.length');
    /** The panel as it reads: each row and pill, measured where it stands. */
    const panel = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const box = (e) => { const r = e.getBoundingClientRect(); return { height: r.height, width: r.width }; };
      const list = document.querySelector('#agents');
      return {
        page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
        rows: [...list.querySelectorAll('.agent-card')].map((card) => {
          const row = card.querySelector('.agent-row');
          return { id: row.dataset.agent, text: row.innerText.replace(/\\s+/g, ' ').trim(), title: row.title, height: box(row).height, on: card.classList.contains('on'),
            avatars: row.querySelectorAll('.avatar').length, name: row.querySelector('.agent-who b').textContent, model: row.querySelector('.agent-model').textContent,
            state: row.querySelector('.agent-state').textContent, item: row.querySelector('.agent-what').textContent.trim(),
            whoBottom: row.querySelector('.agent-who').getBoundingClientRect().bottom, itemTop: row.querySelector('.agent-doing').getBoundingClientRect().top,
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
        // The approved entry keeps identity and time/state above its held item, with extra holds on hover.
        assert.deepEqual(p.rows.map((row) => row.id), ['web-1'], `${at}: only an agent holding work takes a row`);
        const [row] = p.rows;
        assert.deepEqual([row.avatars, row.name, row.model, row.item], [0, 'web-1', 'Test Model', '#1 Header'], `${at}: complete native identity and held item: ${row.text}`);
        assert.match(row.state, /^(?:now|\d+[mhd])Buildingby web-1 \(Test Model\)$/, `${at}: native age stays beside the approved stage and full holder name`);
        assert.ok(row.itemTop >= row.whoBottom && row.title.includes('+1 more item') && !row.text.includes('+1'), `${at}: the item occupies its own line and additional work is on hover`);
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
    await chrome.click(`document.querySelector('#agents .agent-row[data-agent="web-1"]')`);
    let p = await panel();
    assert.deepEqual([p.rows[0].on, p.rows[0].work.map(([id]) => id), p.chip, p.to, p.cards], [true, ['1', '2'], 'to web-1 (Test Model)×', 'web-1', [['web-1', 'coordinator and you']]],
      `the picked row opens to what it holds, the feed shows its shouts and the composer is addressed to it: ${JSON.stringify(p)}`);
    assert.ok(p.rows[0].work.every(([, height]) => height >= tapTarget(1280)), 'each thing it holds is a target');
    // A pill does the same.
    await chrome.click(`document.querySelector('#agents .agent-pill[data-agent="web-2"]')`);
    p = await panel();
    assert.deepEqual([p.pills.find((pill) => pill.id === 'web-2').on, p.chip, p.cards], [true, 'to web-2 (Test Model)×', [['web-2', 'coordinator and you']]], 'a pill filters and addresses too');
    // And a thing an agent holds opens its item.
    await chrome.click(`document.querySelector('#agents .agent-row[data-agent="web-1"]')`);
    await chrome.click(`document.querySelector('#agents .agent-work[data-item="2"]')`);
    await chrome.waitFor(`!document.querySelector('[data-pane=items]').hidden && document.querySelector('#detail h2')?.textContent.includes('Footer')`);
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('the shout feed names a seat broadcast and an item shout in product words [N26,A5]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for rendered feed checks.');
  const box = machine();
  const alpha = project(box, 'recipients');
  await box.inProcess(alpha.repo, 'add', 'web', 'Header', '--specs', 'G1', '--criterion', 'renders');
  // A registered seat's shout to all is stored at coordinator+person; an item shout is stored at item:<id>.
  await box.inProcess(alpha.web, 'shout', 'all', 'Seat broadcast for the coordinator');
  await box.inProcess(alpha.web, 'shout', '--item', '1', 'Item shout for its audience');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-recipients-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('typeof data !== "undefined" && data?.project?.shouts?.length >= 2');
    await chrome.click("document.querySelector('[data-tab=shouts]')");
    await chrome.waitFor('document.querySelectorAll("#feed .conversation-row").length === 2');
    await openConversation(chrome);
    for (const width of [1280, 375]) {
      await shoutsAt(chrome, width, 'light');
      const at = `${width}px`;
      const snapshots = [];
      for (const key of ['none', 'item:1']) {
        await openConversation(chrome, key);
        snapshots.push(JSON.parse(await chrome.stable(`JSON.stringify({
          tos: [...document.querySelectorAll('#feed .shout .to')].map((to) => to.textContent),
          link: document.querySelector('#feed .shout .to a.ref')?.dataset.go ?? null,
          text: document.querySelector('#feed').innerText }) `)));
      }
      const feed = { tos: snapshots.flatMap(snapshot => snapshot.tos), link: snapshots.find(snapshot => snapshot.link)?.link,
        text: snapshots.map(snapshot => snapshot.text).join('\n') };
      assert.ok(feed.tos.includes('→ coordinator and you'), `${at}: a seat broadcast reads coordinator and you: ${JSON.stringify(feed.tos)}`);
      assert.ok(feed.tos.includes('→ #1'), `${at}: an item shout reads its id: ${JSON.stringify(feed.tos)}`);
      assert.equal(feed.link, 'item:1', `${at}: the item id links to the item`);
      assert.ok(!feed.text.includes('coordinator+person') && !feed.text.includes('item:'), `${at}: no card shows the internal address`);
    }
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
  const alpha = project(box, 'model-names', SPEC, {}, { joinSeat: false });
  const model = 'GPT-6 with a very long model declaration for readable agent names';
  await box.inProcess(alpha.web, 'join', 'web', '--model', model, '--route', 'strong');
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try { register(board, { lane: 'coordinator', path: alpha.repo, model: 'Claude' }); }
  finally { closeBoard(board); }
  for (const title of ['Known holder', 'Reviewed model', 'Unknown holder']) {
    await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'visible');
  }
  build(box, alpha, 2, 'reviewed.txt');
  accept(box, alpha, 2);
  await box.inProcess(alpha.web, 'claim', '1');
  const unknown = join(box.dir, 'unknown-web');
  box.git(alpha.repo, 'worktree', 'add', '-q', unknown, '-b', 'web/unknown');
  // An existing stored registration may have no model even though new CLI joins require one.
  const legacyBoard = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try { register(legacyBoard, { lane: 'web', path: unknown }); }
  finally { closeBoard(legacyBoard); }
  await box.inProcess(unknown, 'claim', '3');
  await box.inProcess(alpha.web, 'shout', 'web-2', 'Known sender and unknown recipient');
  await box.inProcess(unknown, 'shout', 'all', 'Unknown sender and a lane-free recipient');
  await box.inProcess(alpha.repo, 'shout', 'all', 'A coordinator broadcast reaches everyone');
  await box.inProcess(alpha.repo, 'shout', 'person', 'A model decision', '--decision');
  await box.inProcess(alpha.repo, 'hold', 'web', '--reason', 'Wait for the model decision');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Model release', '--items', '1,2,3', '--reason', 'Arrange fixture release');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-model-names-chrome-'));
  let chrome;
  /** Read rendered text from the real browser without changing its API data. */
  const text = (selector) => chrome.stable(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
  /** Press a real control and wait until its requested pane is drawn. */
  const tab = async (name) => {
    await press(chrome, `document.querySelector('[data-tab="${name}"]')`);
    await settled(chrome, `view.tab === ${JSON.stringify(name)}`);
  };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.stable(`(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__modelDetailDelay = { started: 0, completed: 0, milliseconds: 5000 };
      /** Keep the summary heading visible while the verified item's detail is in flight. */
      window.fetch = async (...args) => {
        const path = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname;
        if (path.startsWith('/api/v1/boards/') && path.endsWith('/items/2')) {
          window.__modelDetailDelay.started += 1;
          await new Promise(resolve => setTimeout(resolve, window.__modelDetailDelay.milliseconds));
          window.__modelDetailDelay.completed += 1;
        }
        return nativeFetch(...args);
      };
      return true;
    })()`);
    await settled(chrome, "data?.project?.agents?.length === 3 && !!document.querySelector('#chain [data-item=\"1\"]')");
    for (const style of ['suffix', 'prefix']) {
      if (style === 'prefix') {
        const configFile = join(alpha.repo, 'pullboard.json');
        const config = JSON.parse(readFileSync(configFile, 'utf8'));
        config.agents = { ...(config.agents || {}), names: 'prefix' };
        writeFileSync(configFile, JSON.stringify(config, null, 2));
        box.git(alpha.repo, 'add', 'pullboard.json');
        box.git(alpha.repo, 'commit', '-q', '-m', 'chore: use prefix names');
        await chrome.stable('refresh()');
      }
      const apiExpected = style === 'suffix'
        ? { builder: 'web-1 (' + model + ')', reviewer: 'coordinator (Claude)', unknown: 'web-2 (unknown)' }
        : { builder: 'gpt-6-with-a-very-long-model-declaration-for-readable-agent-names-web-1', reviewer: 'claude-coordinator', unknown: 'unknown-web-2' };
      const displayModel = 'GPT-6 With A Very Long Model Declaration For Readable Agent Names';
      const expected = style === 'suffix' ? { builder: 'web-1 (' + displayModel + ')', reviewer: 'coordinator (Claude)', unknown: 'web-2' } : { builder: displayModel + '-web-1', reviewer: 'Claude-coordinator', unknown: 'web-2' };
      const apiNames = JSON.parse(await chrome.stable('JSON.stringify(Object.fromEntries(data.project.agents.map(a => [a.agent_id, a.displayName])))'));
      assert.deepEqual(apiNames, { coordinator: apiExpected.reviewer, 'web-1': apiExpected.builder, 'web-2': apiExpected.unknown }, `${style}: authoritative API names`);
      for (const width of [375, 1280]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await settled(chrome, `innerWidth === ${width}`);
        const at = `${style} ${width}`;
        await tab('items');
        await chooseFilter(chrome, 'state:active');
        await settled(chrome, '!!document.querySelector("#chain [data-item=\\"1\\"]")');
        assert.match(await chrome.stable("document.querySelector('#chain [data-item=\"1\"] .item-seat').getAttribute('aria-label')"), /^Building:/u, `${at}: held item stage is accessible`);
        assert.ok((await text('#chain [data-item="1"] .stage-detail')).includes(expected.builder), `${at}: item row names its holder`);
        assert.match(await chrome.stable("document.querySelector('#chain [data-item=\"3\"] .item-seat').getAttribute('aria-label')"), /^Building:/u, `${at}: unknown model held stage is accessible`);
        assert.ok((await text('#chain [data-item="3"] .stage-detail')).includes(expected.unknown), `${at}: unknown model remains visible in its detail`);
        assert.equal(await text('#chain [data-item="1"] .item-seat'), 'web-1', `${at}: accepted compact row keeps the native holder`);
        assert.ok(await chrome.stable("document.querySelector('#chain [data-item=\"1\"] .item-seat').title.includes(" + JSON.stringify(displayModel) + ")"), `${at}: the private row model is canonical on hover`);
        assert.equal(await text('#chain [data-item="3"] .chip'), expected.unknown, `${at}: unknown model row`);
        await press(chrome, 'document.querySelector("#chain [data-item=\\"1\\"]")');
        await settled(chrome, `view.item === 1 && !!document.querySelector("#detail h2") && !document.querySelector('#detail [aria-busy="true"]')`);
        assert.ok((await text('#detail')).includes(expected.builder), `${at}: held item detail`);
        assert.equal(await text('#needs details[data-needs-key^="decision:"] [data-needs-field="asked-by"]'), expected.reviewer, `${at}: Needs-you decision author`);
        assert.ok((await text('#needs details[data-needs-key^="hold:"] .needs-copy small')).includes('lane held by ' + expected.reviewer), `${at}: Needs-you lane holder`);
        await chooseFilter(chrome, 'state:verified');
        await settled(chrome, '!!document.querySelector("#chain [data-item=\\"2\\"]")');
        await press(chrome, 'document.querySelector("#chain [data-item=\\"2\\"]")');
        await settled(chrome, `view.item === 2 && !!document.querySelector("#detail h2") && !document.querySelector('#detail [aria-busy="true"]') && !!document.querySelector('#detail .verdict .by')`);
        const detail = await text('#detail');
        const detailState = JSON.parse(await chrome.stable(`JSON.stringify({
          heading: !!document.querySelector('#detail h2'),
          busy: !!document.querySelector('#detail [aria-busy="true"]'),
          verdict: !!document.querySelector('#detail .verdict .by'), delay: window.__modelDetailDelay })`));
        t.diagnostic(JSON.stringify({ checkpoint: at, ...detailState,
          capturedText: detail, builderPresent: detail.includes(expected.builder), reviewerPresent: detail.includes(expected.reviewer) }));
        assert.ok(detail.includes(expected.builder) && detail.includes(expected.reviewer), `${at}: builder and verifier detail`);
        assert.ok((await text('#detail .verdict .by')).startsWith(expected.reviewer), `${at}: verdict identity`);
        await tab('shouts');
        for (const [id, label] of [['web-1', expected.builder], ['web-2', expected.unknown]]) {
          assert.equal(await text(`#agents [data-agent="${id}"] .agent-who b`), id, `${at}: compact agent panel keeps the seat ${id}`);
          assert.equal(await text(`#agents [data-agent="${id}"] .agent-model`), id === 'web-1' ? displayModel : 'unknown', `${at}: model stays a separate faint field`);
        }
        if (!await chrome.stable('Boolean(view.open.idle)')) await press(chrome, 'document.querySelector("[data-fold=idle]")');
        assert.equal((await text('#agents [data-agent="coordinator"]')).trim(), 'coordinator', `${at}: idle agent seat`);
        assert.ok(await chrome.stable(`document.querySelector('#agents [data-agent="coordinator"]').title.includes(${JSON.stringify(expected.reviewer)})`), `${at}: idle agent retains the native model name on hover`);
        await openConversation(chrome);
        const feed = await text('#feed');
        assert.ok(feed.includes('web-1') && feed.includes('web-2') && feed.includes('coordinator'), `${at}: visible shout sender and recipient seats`);
        assert.ok(feed.includes('→ all') && feed.includes('→ you'), `${at}: person and broadcast recipients keep their names`);
        const headers = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#feed .shout header')].map(header => {
          const rect = header.getBoundingClientRect(), reference = header.cloneNode(true);
          reference.style.cssText = 'position:fixed;left:-10000px;width:max-content;max-width:none;height:auto;';
          header.parentElement.append(reference); const line = reference.getBoundingClientRect().height; reference.remove();
          return { height: rect.height, line,
            labels: [...header.querySelectorAll('[data-agent-address]')].map(label => {
              const box = label.getBoundingClientRect();
              return { name: label.textContent, title: label.title, aria: label.getAttribute('aria-label'), id: label.dataset.agentAddress,
                left: box.left, right: box.right, headerLeft: rect.left, headerRight: rect.right, idWidth: label.clientWidth, idScroll: label.scrollWidth };
            }) };
        }))`));
        assert.ok(headers.length > 0, `${at}: real shout headers render`);
        const accessible = await chrome.send('Accessibility.getFullAXTree');
        const names = accessible.nodes.filter(node => node.role?.value === 'group' && !node.ignored).map(node => node.name?.value);
        assert.ok(names.includes(expected.builder) && names.includes(expected.unknown) && names.includes(expected.reviewer), `${at}: Chrome exposes complete model names to assistive readers`);

        for (const header of headers) {
          assert.ok(header.height <= header.line + 1, `${at}: shout identity stays on one line: ${JSON.stringify(header)}`);
          for (const label of header.labels) {
            assert.equal(label.title, ({ 'web-1': displayModel, coordinator: 'Claude', 'web-2': 'unknown' })[label.id], `${at}: full model stays only in the tooltip`);
            assert.equal(label.aria, ({ 'web-1': expected.builder, coordinator: expected.reviewer, 'web-2': expected.unknown })[label.id], `${at}: full native API name stays accessible`);
            assert.equal(label.idWidth, label.idScroll, `${at}: the address is never clipped`);
            assert.ok(label.left >= label.headerLeft - 1 && label.right <= label.headerRight + 1, `${at}: address stays inside its header`);
          }
        }
        assert.ok(headers.flatMap(header => header.labels).every(label => !label.name.includes(displayModel)), `${at}: the model is on hover while every complete seat address stays visible`);

        await press(chrome, 'document.querySelector("#agents [data-agent=\\"web-1\\"]")');
        await settled(chrome, 'view.agent === "web-1"');
        assert.equal(await chrome.stable('view.agent'), 'web-1', `${at}: filtering retains the raw API id`);
        await press(chrome, 'document.querySelector("[data-agent=\\"\\"]")');
        await tab('activity');
        const activityNames = JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#activity .activity-who')].map(node => ({ text: node.textContent, title: node.title })))"));
        for (const identity of [
          { text: 'web-1', title: displayModel },
          { text: 'web-2', title: '' },
          { text: 'The coordinator', title: 'Claude' }
        ]) assert.ok(activityNames.some(actual => actual.text === identity.text && actual.title === identity.title), `${at}: Activity retains seat identity and the known model hover: ${JSON.stringify(identity)}`);
        await tab('roadmap');
        // Disclosure choices survive tab visits: explicitly fold rows before testing the collapsed view.
        const opened = JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#roadmap .milestone-item[aria-expanded=true]')].map(row => row.dataset.roadmapKey))"));
        for (const key of opened) await press(chrome, `document.querySelector('#roadmap .milestone-item[data-roadmap-key="${key}"]')`);
        const collapsed = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const rows = [...document.querySelectorAll('#roadmap .milestone-item')];
          /** Read all collapsed copy except the single approved stage detail and hidden disclosure bodies. */
          const outsideStageDetail = element => {
            const copy = element.cloneNode(true);
            copy.querySelectorAll('[hidden], .stage-detail').forEach(node => node.remove());
            return copy.textContent;
          };
          return { outsideDetail: outsideStageDetail(document.querySelector('#roadmap')), rows: rows.map(row => {
            const detail = row.parentElement.querySelector('.milestone-why');
            return { key: row.dataset.roadmapKey, outsideDetail: outsideStageDetail(row), stageDetails: [...row.querySelectorAll('.stage-detail')].map(node => node.textContent), expanded: row.getAttribute('aria-expanded'), hidden: detail.hidden, rendered: detail.getClientRects().length > 0 };
          }) };
        })())`));
        assert.equal(collapsed.rows.length, 3, `${at}: all fixture rows are checked`);
        assert.doesNotMatch(collapsed.outsideDetail, /web-[12]|coordinator/, `${at}: collapsed Roadmap names agents only in the approved stage detail`);
        for (const row of collapsed.rows) {
          assert.doesNotMatch(row.outsideDetail, /web-[12]|coordinator/, `${at}: collapsed row headers add no names outside their stage detail`);
          assert.deepEqual(row.stageDetails, [({ 'i:#1': 'by ' + expected.builder, 'i:#3': 'by ' + expected.unknown, 'i:#2': 'queued for the train' })[row.key]], `${at}: each row has exactly its one truthful stage detail`);
          assert.deepEqual([row.expanded, row.hidden, row.rendered], ['false', true, false], `${at}: collapsed details are hidden and unrendered`);
        }
        const roadmapRow = "document.querySelector('#roadmap .milestone-item[data-roadmap-key=\"i:#1\"]')";
        await press(chrome, roadmapRow);
        await chrome.waitFor(`${roadmapRow}.getAttribute('aria-expanded') === 'true' && [...${roadmapRow}.parentElement.querySelectorAll('.roadmap-detail dt')].some(field => field.textContent === 'Agents' && field.nextElementSibling.textContent.includes(${JSON.stringify(expected.builder)}))`);
        const expanded = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const detail = ${roadmapRow}.parentElement.querySelector('.milestone-why');
          const agents = [...detail.querySelectorAll('.roadmap-detail dt')].find(field => field.textContent === 'Agents')?.nextElementSibling;
          return { shown: !detail.hidden && detail.getClientRects().length > 0, agents: agents?.innerText || '' };
        })())`));
        assert.equal(expanded.shown, true, `${at}: the expanded row displays its detail`);
        assert.ok(expanded.agents.includes(expected.builder), `${at}: the approved Agents field uses the API display name`);
        await press(chrome, `${roadmapRow}.parentElement.querySelector('.milestone-why a[data-go="item:1"]')`);
        await settled(chrome, `view.tab === "items" && view.item === 1 && !!document.querySelector("#detail h2") && !document.querySelector('#detail [aria-busy="true"]')`);
        assert.ok((await text('#detail')).includes(expected.builder), `${at}: roadmap item opens with the API identity`);
        assert.ok(await chrome.stable('document.documentElement.scrollWidth <= innerWidth'), `${at}: no sideways overflow`);
      }
    }
    assert.ok(await chrome.stable('window.__modelDetailDelay.started >= 1'), 'the fixed delayed-detail control was exercised');
    assert.deepEqual(chrome.exceptions, [], 'all model-name views run without browser exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('staged and exported boards carry API model display names [O8,N26,A10]', async () => {
  const box = machine();
  const alpha = project(box, 'model-export', SPEC, { agents: { names: 'prefix' } }, { joinSeat: false });
  await box.inProcess(alpha.web, 'join', 'web', '--model', 'GPT-6', '--route', 'strong');
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
    await exportView(alpha.repo, directory, { runCommand: nativeTestMain });
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
  /** Retain the exact real setup or security action reached if the unchanged test ceiling expires. */
  const stage = name => t.diagnostic('credential inventory stage: ' + name);
  stage('fixture');
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
  stage('enrollment pending');
  const pending = await waitFixture(() => existsSync(machineFile) && JSON.parse(readFileSync(machineFile, 'utf8')).pending,
    'foreground pairing publishes the one-use device enrollment');
  stage('phone session');
  const phone = await box.phoneSession();
  stage('phone Chrome');
  const phoneChrome = await stableChrome(await startChrome());
  t.after(() => phoneChrome.close());
  const localChrome = await stableChrome(await startChrome());
  t.after(() => localChrome.close());
  assert.equal((await phoneChrome.send('Network.setCookie', {
    name: 'pb_session', value: phone.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true);
  stage('device confirmation');
  await phoneChrome.navigate(`${box.origin}/#device=${pending.locator}.${pending.secret}`);
  stage('device navigation returned');
  try { await phoneChrome.waitFor("document.querySelector('#phone-approvals') !== null"); }
  catch (error) {
    const observed = JSON.parse(await phoneChrome.stable(`JSON.stringify({
      heading: document.querySelector('#relay-notice h1, #relay-notice h2')?.textContent || '',
      codes: [...(document.querySelector('#relay-notice')?.textContent || '').matchAll(/\\b[A-Z]+(?:_[A-Z0-9]+)+\\b/g)].map(match => match[0]),
      signedIn: Boolean(document.querySelector('[data-relay-session]')),
      approvals: Boolean(document.querySelector('#phone-approvals')),
    })`));
    t.diagnostic(JSON.stringify({ phoneSetup: observed,
      enrollReads: box.calls.filter(call => call.method === 'GET' && call.path.includes('/devices/enrollments/')).length,
      enrollWrites: box.calls.filter(call => call.method === 'PUT' && call.path.includes('/devices/enrollments/')).length,
      childExited: setup.exitCode !== null }));
    throw error;
  }
  stage('phone enrollment page ready');
  assert.equal((await setupDone).code, 0, 'the real phone session pairs the machine');

  stage('first agent');
  const joined = await box.cli('worktree', box.lane);
  assert.equal(joined.code, 0, joined.failure ?? 'a real agent worktree joins with machine credentials');
  const agentRoot = joined.document.path;
  const agentId = joined.document.agent;
  stage('second agent');
  const other = await box.cli('worktree', box.lane);
  assert.equal(other.code, 0, other.failure ?? 'a second agent receives its own credential');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const oldPA = link.agentTokens[agentId], otherPA = link.agentTokens[other.document.agent];
  // Every seat this machine holds a token for. Today that is the two agents; when the main checkout
  // authenticates as the coordinator to create them (#579), the coordinator's own token joins them.
  const expectedAgents = Object.keys(link.agentTokens).sort();
  assert.deepEqual(expectedAgents.filter(seat => ![agentId, other.document.agent, 'coordinator'].includes(seat)), [],
    'the machine holds tokens only for the two agents and the coordinator that created them');
  assert.ok([agentId, other.document.agent].every(seat => expectedAgents.includes(seat)), 'each agent holds its own cached token');
  assert.match(oldPA.token, /^pa_[A-Za-z0-9_-]{43}$/u);
  const listed = await box.cli('relay', 'tokens');
  assert.equal(listed.code, 0, listed.failure ?? 'the real CLI reads token metadata');
  const expected = listed.document.tokens.find(row => row.agent === agentId);
  assert.ok(expected?.id && expected.created && expected.expires);
  assert.deepEqual(listed.document.tokens.map(row => row.agent).sort(), expectedAgents, 'both independent agent credentials are listed');
  assert.equal(JSON.stringify(listed.document).includes(oldPA.token), false, 'the native inventory contains no PA value');

  stage('local view');
  const view = await startView({ dir: box.root, env: personEnv });
  try {
    await localChrome.navigate(view.link.href);
    await localChrome.waitFor("typeof data === 'object' && !!data?.project");
    /** Deliver actual mouse input only after layout settles and the target is uncovered. */
    const tap = async (selector) => {
      await press(localChrome, `document.querySelector(${JSON.stringify(selector)})`);
    };
  stage('inventory pane');
    await tap('[data-tab="shouts"]');
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      await localChrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await localChrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await localChrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      if (!await localChrome.stable('Boolean(document.querySelector("[data-token-id]"))')) await tap('[data-credentials]');
      for (const metadata of listed.document.tokens) {
        const selector = `[data-token-id="${metadata.id}"]`;
        await localChrome.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
        const row = JSON.parse(await localChrome.stable(`JSON.stringify((() => {
          const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
          return {id:e.dataset.tokenId,text:e.innerText,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
            rowOverflow:r.right>document.documentElement.clientWidth};
        })())`));
        assert.equal(row.id, metadata.id);
        for (const value of [metadata.id, metadata.agent, new Date(metadata.created).toISOString(), new Date(metadata.expires).toISOString()]) {
          assert.ok(row.text.includes(value), `${width}/${scheme}: the row shows token id, agent and ISO creation/expiry`);
        }
        assert.equal(row.text.includes(oldPA.token), false, 'the credential value never enters the DOM');
        for (const secret of [oldPA.token, otherPA.token, ...Object.values(link.agentTokens).map(row => row.token), link.token, phone.token, readFileSync(box.keyFile, 'utf8').trim()]) {
          assert.equal(await localChrome.stable(`document.documentElement.outerHTML.includes(${JSON.stringify(secret)}) || JSON.stringify(data).includes(${JSON.stringify(secret)}) || JSON.stringify([...credentials]).includes(${JSON.stringify(secret)})`), false,
            'the local page, projected board and inventory retain no credential value or board key');
        }
        assert.equal(await localChrome.stable(`document.querySelector(${JSON.stringify(selector)}).querySelector('[data-revoke-token]').getBoundingClientRect().height >= 44`), true,
          `${width}/${scheme}: revocation has a full touch target`);

        assert.equal(row.overflow || row.rowOverflow, false, `${width}/${scheme}: the inventory stays within the viewport`);
      }
    }

  stage('revoke');
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
    await press(phoneChrome, `[...document.querySelectorAll('.phone-approval')].find(node => node.textContent.includes(${JSON.stringify(expected.id)}))?.querySelector('button')`);
    await localChrome.waitFor("document.querySelector('#credentials [role=status]')?.textContent.includes('Credential revoked.')");
    assert.equal(await localChrome.stable(`document.querySelector('[data-token-id="${expected.id}"]')?.textContent.includes('Revoked')`), true, 'the acknowledged credential row is marked revoked');
    assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length, authorizationsBefore + 1,
      'one real phone tap authorizes exactly one revoke');

  stage('negative controls');
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
    const unaffected = await runFixtureChildAsync(process.execPath, [BIN, 'shout', 'all', 'the other credential still works', '--json'], {
      cwd: other.document.path, env: { ...personEnv, PULLBOARD_RELAY_TOKEN: otherPA.token, AI_AGENT: '1', CODEX_SHELL: '1', CODEX_THREAD_ID: 'private-credential-inventory-other' },
    });
    assert.equal(unaffected.status, 0, 'revoking one credential leaves the other agent able to move');
  } finally {
    await localChrome.close();
    await phoneChrome.close();
    await view.stop();
  }
});
