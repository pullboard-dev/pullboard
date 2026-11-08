// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-test-input apps/view/src/shell/view.css apps/view/src/shell/view/cost.css apps/view/src/shell/view/doctrine.css */
/** Private cost presentation and actual local-board rendering with configured machine prices [N26]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { costTabHtml } from '../../apps/view/index.js';
import { costTabModel } from '../../apps/view/index.js';
import { counterDelta } from '../../apps/view/index.js';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../apps/cli/index.js';
import * as store from '../../src/board.js';
import { SPEC } from './fixture.js';
import { machine } from './fixture.js';
import { project } from './fixture.js';
import { build } from './fixture.js';
import { accept } from './fixture.js';
import { startView } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { press } from './fixture.js';
import { serveFolder } from './fixture.js';
import { openBoard } from '../../apps/lib/index.js';

/** Make one deterministic presenter-only usage history; it is not native provider data. */
function pricedHistory() {
  const items = [], events = [], rate = { freshInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 0 };
  for (let id = 1; id <= 30; id++) {
    const builder = 'builder-' + id, reviewer = 'reviewer-' + id;
    const landedAt = new Date(Date.UTC(2026, 0, id)).toISOString();
    items.push({ id, title: 'Cost item ' + id, builtBy: builder });
    events.push({ event_id: id * 5, event_kind: 'submit', item_id: id, event_by: builder, event_at: landedAt });
    events.push({ event_id: id * 5 + 1, event_kind: 'usage', event_by: builder, event_detail: JSON.stringify({ item: id, revision: 1, records: [{ model: 'Fixture model', freshInputTokens: id === 30 ? 100_000_000 : id * 1_000_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, wallMs: 3_600_000 }] }) });
    events.push({ event_id: id * 5 + 2, event_kind: 'accept', item_id: id, event_by: reviewer, event_at: landedAt });
    events.push({ event_id: id * 5 + 3, event_kind: 'usage', event_by: reviewer, event_detail: JSON.stringify({ item: id, revision: 1, records: [{ model: 'Reviewer model', freshInputTokens: 0, cacheReadInputTokens: 2_000_000, cacheWriteInputTokens: 3_000_000, outputTokens: 4_000_000, wallMs: 1_800_000 }] }) });
    events.push({ event_id: id * 5 + 4, event_kind: 'merged', item_id: id, event_detail: JSON.stringify({ commit: `commit-${id}` }), event_at: landedAt });
  }
  const agents = items.flatMap(item => [
    { agent_id: item.builtBy, model: 'Fixture model', family: 'Fixture vendor' },
    { agent_id: 'reviewer-' + item.id, model: 'Reviewer model', family: 'Fixture vendor' },
  ]);
  const prices = { 'Fixture model': rate, 'Reviewer model': { freshInput: 0, cacheReadInput: 1, cacheWriteInput: 1, output: 1 } };
  return { project: { items, agents }, events, prices };
}

test('the Cost presenter keeps the newest twenty landings, median bands and session detail truthful [N26]', () => {
  const { project: input, events, prices } = pricedHistory();
  const model = costTabModel(input, events, prices);
  assert.equal(model.rows.length, 20);
  assert.deepEqual(model.rows.map(row => row.id), Array.from({ length: 20 }, (_, index) => 30 - index));
  assert.equal(model.total, 660);
  assert.equal(model.perLanding, 33);
  assert.equal(model.median, 29.5);
  assert.equal(model.reworkShare, 0);
  assert.equal(model.rows[0].agentHours, 1.5);
  assert.equal(model.rows[0].rounds, 1);
  const html = costTabHtml(model, 30);
  assert.match(html, /class="cost-row cost-red"[^>]*data-cost-row="30"/u);
  assert.match(html, /class="cost-row cost-amber"[^>]*data-cost-row="29"/u);
  assert.match(html, /<b>Builder model|<b>Fixture model/u);
  assert.match(html, /Fresh input/u);
  assert.match(html, /Cached input/u);
  assert.match(html, /Cached write/u);
  assert.match(html, /Output/u);
  assert.match(html, /100000000/u);
  assert.match(html, /2000000/u);
  assert.match(html, /3000000/u);
  assert.match(html, /4000000/u);
  assert.match(html, /rework|review/iu);
  assert.match(html, /Reviewer model/u);
  assert.match(html, /Other/u);
  assert.match(html, /Cost item 30/u);
});

test('items without native usage render dashes instead of zero-dollar claims [N26]', () => {
  const model = costTabModel({ items: [{ id: 9, title: 'No usage', builtBy: 'builder' }], agents: [{ agent_id: 'builder', model: 'Model A' }] }, [
    { event_id: 1, event_kind: 'submit', item_id: 9, event_by: 'builder' },
    { event_id: 2, event_kind: 'merged', item_id: 9, event_detail: '{}' },
  ]);
  const html = costTabHtml(model, 9);
  assert.equal(model.rows[0].totalCost, null);
  assert.match(html, /<b class="cost-amount" data-label="Cost">—<\/b>/u);
  assert.match(html, /No usage record; token and cost figures are unavailable\./u);
  assert.doesNotMatch(html, /\$0\.00/u);
  assert.match(html, /Model A/u, 'the builder model remains available from native seat metadata without usage');
});

test('unknown and decreasing cumulative baselines stay unknown [N26]', () => {
  assert.equal(counterDelta({ inputTokens: 12 }, undefined, 'inputTokens'), 12);
  assert.equal(counterDelta({ inputTokens: 12 }, {}, 'inputTokens'), null);
  assert.equal(counterDelta({ inputTokens: 8 }, { inputTokens: 12 }, 'inputTokens'), null);
});

test('shared usage never appears as per-item or vendor dollars [N26]', () => {
  const records = value => [{ model: 'Model A', freshInputTokens: value, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, wallMs: 60_000 }];
  const events = [
    { event_id: 1, event_kind: 'claim', item_id: 88, event_by: 'builder' },
    { event_id: 2, event_kind: 'submit', item_id: 88, event_by: 'builder' },
    { event_id: 3, event_kind: 'usage', event_by: 'builder', event_detail: JSON.stringify({ item: 88, revision: 1, records: records(1_000_000) }) },
    { event_id: 4, event_kind: 'reject', item_id: 88, event_by: 'reviewer' },
    { event_id: 5, event_kind: 'claim', item_id: 88, event_by: 'builder' },
    { event_id: 6, event_kind: 'usage', event_by: 'builder', event_detail: JSON.stringify({ item: 88, revision: 2, records: records(2_000_000) }) },
    { event_id: 7, event_kind: 'shared-usage', event_detail: JSON.stringify({ allocations: [{ item: 88, seat: 'builder' }, { item: 89, seat: 'peer' }] }) },
    { event_id: 8, event_kind: 'merged', item_id: 88, event_detail: '{}', event_at: '2026-10-29T00:00:00.000Z' },
  ];
  const model = costTabModel({ items: [{ id: 88, title: 'Shared usage', builtBy: 'builder' }], agents: [
    { agent_id: 'builder', model: 'Model A', family: 'Vendor A' },
  ] }, events, { 'Model A': { freshInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 0 } });
  assert.equal(model.rows[0].totalCost, null);
  assert.ok(model.rows[0].usageRows.every(entry => entry.costUSD === null));
  assert.equal(model.rows[0].returns[0].costUSD, null);
  assert.equal(model.vendors[0].costUSD, null);
  assert.equal(model.reworkShare, null);

  const sharedCheckpointEvents = events.filter(event => event.event_kind !== 'shared-usage').map(event => {
    if (event.event_id !== 3) return event;
    const detail = JSON.parse(event.event_detail);
    detail.shared = true;
    return { ...event, event_detail: JSON.stringify(detail) };
  });
  const checkpointModel = costTabModel({ items: [{ id: 88, title: 'Shared checkpoint', builtBy: 'builder' }], agents: [
    { agent_id: 'builder', model: 'Model A', family: 'Vendor A' },
  ] }, sharedCheckpointEvents, { 'Model A': { freshInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 0 } });
  assert.equal(checkpointModel.rows[0].totalCost, null);
  assert.ok(checkpointModel.rows[0].usageRows.every(entry => entry.costUSD === null));
  assert.equal(checkpointModel.rows[0].returns[0].costUSD, null);
  assert.equal(checkpointModel.vendors[0].costUSD, null,
    'a shared checkpoint remains unattributed even when no shared-usage allocation event was published');
});

test('cumulative usage preserves priced totals but leaves collapsed lifecycle attribution unknown [N26]', () => {
  const row = (model, freshInputTokens, wallMs) => ({ model, freshInputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, wallMs });
  const usage = (event_id, event_by, revision, records) => ({ event_id, event_kind: 'usage', event_by,
    event_detail: JSON.stringify({ item: 77, revision, records }) });
  const events = [
    { event_id: 1, event_kind: 'claim', item_id: 77, event_by: 'builder' },
    { event_id: 2, event_kind: 'submit', item_id: 77, event_by: 'builder' },
    usage(3, 'builder', 1, [row('Model A', 2_000_000, 60_000)]),
    { event_id: 4, event_kind: 'reject', item_id: 77, event_by: 'reviewer' },
    { event_id: 5, event_kind: 'claim', item_id: 77, event_by: 'builder' },
    usage(6, 'builder', 3, [row('Model A', 5_000_000, 180_000), row('Model B', 2_000_000, 30_000)]),
    usage(7, 'builder', 4, [row('Model A', 5_000_000, 180_000), row('Model B', 2_000_000, 30_000)]),
    usage(8, 'builder', 5, [row('Model A', 8_000_000, 240_000), row('Model B', 4_000_000, 60_000)]),
    { event_id: 9, event_kind: 'submit', item_id: 77, event_by: 'builder' },
    { event_id: 10, event_kind: 'reopen', item_id: 77, event_by: 'reviewer' },
    { event_id: 11, event_kind: 'claim', item_id: 77, event_by: 'builder' },
    usage(12, 'builder', 7, [row('Model A', 10_000_000, 300_000), row('Model B', 5_000_000, 90_000)]),
    usage(13, 'builder', 8, [row('Model A', 12_000_000, 360_000), row('Model B', 6_000_000, 120_000)]),
    { event_id: 14, event_kind: 'submit', item_id: 77, event_by: 'builder' },
    { event_id: 15, event_kind: 'accept', item_id: 77, event_by: 'reviewer' },
    usage(16, 'reviewer', 1, [row('Model C', 1_000_000, 45_000)]),
    { event_id: 17, event_kind: 'merged', item_id: 77, event_detail: '{}', event_at: '2026-10-29T00:00:00.000Z' },
  ];
  const prices = Object.fromEntries(['Model A', 'Model B', 'Model C'].map(model => [model,
    { freshInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 0 }]));
  const model = costTabModel({ items: [{ id: 77, title: 'Returned once', builtBy: 'builder' }], agents: [
    { agent_id: 'builder', model: 'Model A', family: 'Vendor A' },
    { agent_id: 'reviewer', model: 'Model C', family: 'Vendor C' },
  ] }, events, prices);
  assert.equal(model.rows[0].rounds, 3);
  assert.equal(model.rows[0].totalCost, 19, 'complete cumulative deltas remain in the priced item total across revision gaps');
  assert.equal(model.rows[0].returns[0].costUSD, null, 'the reject window includes an unattributable delta');
  assert.equal(model.rows[0].returns[1].costUSD, null, 'the reopen window includes an unattributable delta');
  assert.equal(model.reworkShare, null, 'phase totals stay unknown when a checkpoint interval crosses lifecycle events');
  assert.deepEqual(model.rows[0].usageRows.map(entry => entry.role).sort(), ['build', 'rework', 'rework', 'unattributed', 'unattributed', 'unattributed']);
  assert.equal(model.rows[0].usageRows.filter(entry => entry.role === 'rework').reduce((sum, entry) => sum + entry.costUSD, 0), 8,
    'the two fully observed multi-model rework intervals remain priced even while collapsed intervals stay unallocated');
  assert.ok(Math.abs(model.rows[0].agentHours - (525_000 / 3_600_000)) < 1e-10, 'wall time also uses cumulative deltas');
  assert.match(costTabHtml(model, 77), /Usage by agent, model and phase/u, 'aggregate rows are not described as native sessions');
});

test('the private view shows its last twenty native landings; a public export keeps Cost hidden [N26]', { timeout: 360_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the private Cost view journey.');
  const box = machine(), alpha = project(box, 'cost-tab', SPEC);
  const claudeHome = join(box.dir, 'claude');
  const claudeProject = join(claudeHome, 'projects', 'cost-tab-fixture');
  const claudeSession = 'cost-tab-fixture';
  box.env.CLAUDE_CONFIG_DIR = claudeHome;
  box.env.CLAUDE_CODE_SESSION_ID = claudeSession;
  delete box.env.CODEX_THREAD_ID;
  delete box.env.CODEX_SESSION_ID;
  mkdirSync(claudeProject, { recursive: true });
  writeFileSync(join(claudeProject, `${claudeSession}.jsonl`), JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'assistant',
    message: {
      id: 'cost-tab-baseline',
      model: 'Test Model',
      usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  }) + '\n');
  for (let id = 1; id <= 22; id++) {
    box.run(alpha.repo, 'add', 'web', 'Private cost fixture ' + id, '--specs', 'G1', '--criterion', 'The private view shows its landed row.');
    const fixtureSession = box.env.CLAUDE_CODE_SESSION_ID;
    if (id === 3) delete box.env.CLAUDE_CODE_SESSION_ID;
    try { build(box, alpha, id, `cost-fixture-${id}.txt`); }
    finally { box.env.CLAUDE_CODE_SESSION_ID = fixtureSession; }
    delete box.env.CLAUDE_CODE_SESSION_ID;
    try { accept(box, alpha, id); }
    finally { box.env.CLAUDE_CODE_SESSION_ID = fixtureSession; }
    box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
    box.run(alpha.repo, 'merged', String(id), box.git(alpha.repo, 'rev-parse', 'HEAD'));
  }
  // @pullboard-board-file journey: the private Chrome view renders this persisted project board after native CLI landings.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const agent = store.listAgents(board).find(row => row.agent_lane === 'web');
    assert.ok(agent, 'the seeded board has the native web builder');
    for (let id = 4; id <= 22; id++) {
      const freshInputTokens = id === 21 ? 1_500_000 : id === 22 ? 3_000_000 : 1_000_000;
      store.recordUsage(board, { agentId: agent.agent_id, item: id, revision: 100, observedAt: id, records: [{
        model: id === 4 ? 'fixture-unpriced-model' : 'fixture-priced-model', inputTokens: freshInputTokens, knownInputTokens: freshInputTokens,
        outputTokens: 0, knownOutputTokens: 0, freshInputTokens, cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0, wallMs: 3, unknownReasons: [],
      }] });
    }
  } finally { store.closeBoard(board); }
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const fixturePrices = {
    'Test Model': { freshInput: 0, cacheReadInput: 0, cacheWriteInput: 0, output: 0 },
    'fixture-priced-model': { freshInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 0 },
  };
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const previousSettings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  writeFileSync(settingsFile, JSON.stringify({ ...previousSettings, costPrices: fixturePrices }));
  // @pullboard-board-file journey: compare the Cost presenter with actual usage events from the rendered private board.
  const diagnosticBoard = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  let pricingDiagnostic, nativeVendor;
  try {
    const nativeEvents = store.events(diagnosticBoard);
    const usageEvent = nativeEvents.find(event => event.event_kind === 'usage' && JSON.parse(event.event_detail).item === 22);
    const usageDetail = usageEvent ? JSON.parse(usageEvent.event_detail) : null;
    const nativeProject = {
      items: store.listItems(diagnosticBoard, { all: true }).map(item => ({ id: item.item_id, title: item.item_title, builtBy: item.item_built_by })),
      agents: store.listAgents(diagnosticBoard).map(agent => ({ agent_id: agent.agent_id, model: agent.agent_model, family: agent.family })),
    };
    const nativeModel = costTabModel(nativeProject, nativeEvents, fixturePrices);
    nativeVendor = nativeProject.agents.find(agent => agent.agent_id === usageEvent?.event_by)?.family ?? null;
    pricingDiagnostic = JSON.stringify({
      eventKind: usageEvent?.event_kind ?? null,
      eventItemId: usageEvent?.item_id ?? null,
      usageDetail: usageDetail ? { item: usageDetail.item, revision: usageDetail.revision, records: usageDetail.records } : null,
      configuredRate: usageDetail?.records?.[0] ? fixturePrices[usageDetail.records[0].model] ?? null : null,
      nativeRow: nativeModel.rows.find(row => row.id === 22) ?? null,
      totals: { total: nativeModel.total, median: nativeModel.median },
    });
  } finally { store.closeBoard(diagnosticBoard); }
  const privateRates = { 'Private Cost Rate Sentinel <script> </script>': { freshInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 0 } };
  const privatePage = cockpitPage('', { costPrices: privateRates });
  assert.match(privatePage, /Private Cost Rate Sentinel \\u003cscript>/u,
    'configured rates are safely embedded in the private local page');
  for (const options of [
    { snapshot: true },
    { readOnly: true },
    { transportModule: '/relay/client.js' },
    { hostedLocal: true },
  ]) {
    assert.doesNotMatch(cockpitPage('', { ...options, costPrices: privateRates }), /Private Cost Rate Sentinel|localCostPrices/u,
      'snapshots, hosted pages and relay transports do not receive machine rates');
  }
  const publicOutput = join(box.dir, 'cost-public-export');
  box.run(alpha.repo, 'view', '--export', publicOutput, '--public');
  const publicHtml = readFileSync(join(publicOutput, 'index.html'), 'utf8');
  const publicCss = readFileSync(join(publicOutput, 'view.css'), 'utf8');
  const listing = JSON.parse(readFileSync(join(publicOutput, 'api/v1/boards.json'), 'utf8'));
  const boardDirectory = join(publicOutput, 'api/v1/boards', listing.boards[0].id);
  const publicState = JSON.parse(readFileSync(join(boardDirectory, 'state.json'), 'utf8'));
  const publicEvents = JSON.parse(readFileSync(join(boardDirectory, 'events.json'), 'utf8'));
  assert.doesNotMatch(publicHtml, /data-tab="cost"|id="cost"|costTabModel|freshInputTokens/u,
    'the public page has neither the Cost controls nor its private token renderer');
  assert.doesNotMatch(publicHtml, /fixture-priced-model/u, 'the public page never receives the machine price table');
  assert.doesNotMatch(publicCss, /\.cost-(?:page|row|tiles)\b/u, 'public snapshots do not include the private Cost stylesheet');
  const publicDocuments = JSON.stringify({ publicState, publicEvents });
  assert.doesNotMatch(publicDocuments, /"(?:costUSD|knownCostUSD|costPrices|freshInputTokens|cacheReadInputTokens|cacheWriteInputTokens|inputTokens|outputTokens|knownInputTokens|knownOutputTokens|wallMs)"\s*:/u,
    'the actual public state, event history, item thread and history contain no private cost counters');
  assert.doesNotMatch(publicDocuments, /"(?:event_kind|kind)":"(?:usage|shared-usage)"/u,
    'native usage and shared-usage events are absent from all public event projections');

  writeFileSync(settingsFile, JSON.stringify({ ...previousSettings, costPrices: {} }));
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-cost-tab-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.items?.some(item => item.id === 1)");
    const nativeBuilder = JSON.parse(await chrome.stable("JSON.stringify(data.project.agents.find(agent => agent.agent_lane === 'web'))"));
    assert.equal(nativeBuilder.family, nativeVendor, 'the actual private API keeps the canonical native vendor');
    await press(chrome, "document.querySelector('[data-tab=cost]')");
    await chrome.waitFor("document.querySelector('#cost .cost-model-card')");
    const analytics = JSON.parse(await chrome.stable("JSON.stringify(costHistory.get(view.root).model)"));
    assert.equal(analytics.allItems, 22, 'the real endpoint counts the seeded landings: ' + JSON.stringify({ window: analytics.window, from: analytics.from, to: analytics.to, totals: analytics.totals }));
    assert.equal(analytics.longest.length, 5, 'the server selects the five longest landings');
    await chrome.waitFor("document.querySelectorAll('#cost .cost-row').length === 5");
    const ids = JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#cost [data-cost-row]')].map(node => Number(node.dataset.costRow)))"));
    assert.deepEqual(ids, analytics.longest.map(row => row.id), 'the page renders the server-selected items in order');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1800, deviceScaleFactor: 1, mobile: false });
    await chrome.stable("document.documentElement.dataset.theme = 'light'");
    await press(chrome, "document.querySelector('#cost [data-cost-row]')");
    await chrome.waitFor("document.querySelector('#cost .cost-detail')");
    const shotPath = '/tmp/pullboard-2092-cost-light-1440.png';
    const shot = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('Cost proof screenshot:', shotPath);
    for (const width of [1280, 320]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const layout = JSON.parse(await chrome.stable("JSON.stringify({text:document.querySelector('#cost').innerText,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,buttonHeight:document.querySelector('[data-cost-row]').getBoundingClientRect().height})"));
      assert.match(layout.text, /Models/u);
      assert.doesNotMatch(layout.text, /\$[0-9]/u, 'no dollar figure renders without a server dollars block');
      assert.ok(layout.documentWidth <= layout.viewportWidth, `${width}px view has no horizontal page overflow: ` + await chrome.stable("JSON.stringify([...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0,12).map(e => ({tag:e.tagName, cls:e.className, right:e.getBoundingClientRect().right, width:e.getBoundingClientRect().width})))"));
      assert.ok(layout.buttonHeight >= (width < 900 ? 44 : 32), `${width}px landing row remains a reachable control`);
    }
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1800, deviceScaleFactor: 1, mobile: false });
    const detail = await chrome.stable("document.querySelector('#cost .cost-detail').innerText");
    assert.match(detail, /tokens in|No token count/u);
    assert.doesNotMatch(detail, /0 sessions/u, 'unknown native session counts stay blank');
    const publicView = await serveFolder(publicOutput, '/public/');
    try {
      await chrome.send('Page.navigate', { url: publicView.base + '/public/#cost' });
      await chrome.waitFor("snapshot && data?.project?.items.length === 22");
      assert.equal(await chrome.stable("!!document.querySelector('[data-tab=cost]') || !!document.querySelector('#cost') || view.tab === 'cost'"), false,
        'direct Cost navigation cannot reveal a tab in the actual public snapshot');
      await chrome.stable("localStorage.setItem('snapshot.pb.tab','cost')");
      await chrome.send('Page.reload', { ignoreCache: true });
      await chrome.waitFor("snapshot && data?.project?.items.length === 22");
      assert.equal(await chrome.stable("!!document.querySelector('[data-tab=cost]') || !!document.querySelector('#cost') || view.tab === 'cost'"), false,
        'a forged restored Cost selection also resolves to an ordinary public tab');
      assert.ok(publicView.requests.some(request => request.path.endsWith('/state.json') && request.status === 200));
      assert.ok(publicView.requests.some(request => request.path.endsWith('/events.json') && request.status === 200));
    } finally { await publicView.close(); }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
