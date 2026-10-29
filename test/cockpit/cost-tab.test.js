/** @pullboard-test-gui */
/** Private cost presentation and actual local-board rendering; synthetic prices are presenter-only [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { costTabHtml } from '../../src/view/cost-tab.js';
import { costTabModel } from '../../src/view/cost-tab.js';
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
  assert.match(html, /Fixture vendor/u);
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

test('cumulative usage revisions split build, rework and review costs by their event phase [N26]', () => {
  const row = (model, freshInputTokens, wallMs) => ({ model, freshInputTokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, wallMs });
  const usage = (event_id, event_by, revision, records) => ({ event_id, event_kind: 'usage', event_by,
    event_detail: JSON.stringify({ item: 77, revision, records }) });
  const events = [
    { event_id: 1, event_kind: 'claim', item_id: 77, event_by: 'builder' },
    { event_id: 2, event_kind: 'submit', item_id: 77, event_by: 'builder' },
    usage(3, 'builder', 1, [row('Model A', 2_000_000, 60_000)]),
    { event_id: 4, event_kind: 'reject', item_id: 77, event_by: 'reviewer' },
    { event_id: 5, event_kind: 'claim', item_id: 77, event_by: 'builder' },
    usage(6, 'builder', 2, [row('Model A', 5_000_000, 180_000), row('Model B', 2_000_000, 30_000)]),
    { event_id: 7, event_kind: 'submit', item_id: 77, event_by: 'builder' },
    { event_id: 8, event_kind: 'accept', item_id: 77, event_by: 'reviewer' },
    usage(9, 'reviewer', 1, [row('Model C', 1_000_000, 45_000)]),
    { event_id: 10, event_kind: 'merged', item_id: 77, event_detail: '{}', event_at: '2026-10-29T00:00:00.000Z' },
  ];
  const prices = Object.fromEntries(['Model A', 'Model B', 'Model C'].map(model => [model,
    { freshInput: 1, cacheReadInput: 0, cacheWriteInput: 0, output: 0 }]));
  const model = costTabModel({ items: [{ id: 77, title: 'Returned once', builtBy: 'builder' }], agents: [
    { agent_id: 'builder', model: 'Model A', family: 'Vendor A' },
    { agent_id: 'reviewer', model: 'Model C', family: 'Vendor C' },
  ] }, events, prices);
  assert.equal(model.rows[0].rounds, 2);
  assert.equal(model.rows[0].totalCost, 7, 'the cumulative 5M Model A snapshot contributes only its 3M delta after the reject');
  assert.equal(model.rows[0].returns[0].costUSD, 5, 'the reject shows only the Model A and Model B rework deltas');
  assert.ok(Math.abs(model.reworkShare - 5 / 7) < 1e-10);
  assert.deepEqual(model.rows[0].sessions.map(session => session.role).sort(), ['build', 'review', 'rework', 'rework']);
  assert.ok(Math.abs(model.rows[0].agentHours - (255_000 / 3_600_000)) < 1e-10, 'wall time also uses cumulative deltas');
});

test('the private view shows its last twenty native landings; a public export keeps Cost hidden [N26]', { timeout: 360_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the private Cost view journey.');
  const box = machine(), alpha = project(box, 'cost-tab', SPEC);
  for (let id = 1; id <= 21; id++) {
    box.run(alpha.repo, 'add', 'web', 'Private cost fixture ' + id, '--specs', 'G1', '--criterion', 'The private view shows its landed row.');
    build(box, alpha, id, `cost-fixture-${id}.txt`);
    accept(box, alpha, id);
    box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
    box.run(alpha.repo, 'merged', String(id), box.git(alpha.repo, 'rev-parse', 'HEAD'));
  }
  const publicOutput = join(box.dir, 'cost-public-export');
  box.run(alpha.repo, 'view', '--export', publicOutput, '--public');
  const publicHtml = readFileSync(join(publicOutput, 'index.html'), 'utf8');
  const listing = JSON.parse(readFileSync(join(publicOutput, 'api/v1/boards.json'), 'utf8'));
  const boardDirectory = join(publicOutput, 'api/v1/boards', listing.boards[0].id);
  const publicState = JSON.parse(readFileSync(join(boardDirectory, 'state.json'), 'utf8'));
  const publicEvents = JSON.parse(readFileSync(join(boardDirectory, 'events.json'), 'utf8'));
  assert.doesNotMatch(publicHtml, /data-tab="cost"|id="cost"|costTabModel|freshInputTokens/u,
    'the public page has neither the Cost controls nor its private token renderer');
  assert.doesNotMatch(JSON.stringify({ publicState, publicEvents }), /"(?:costUSD|knownCostUSD|costPrices)"\s*:/u,
    'the actual public state, complete event history, item thread and history have no private dollar fields');

  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-cost-tab-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.items?.some(item => item.id === 1)");
    await press(chrome, "document.querySelector('[data-tab=cost]')");
    await chrome.waitFor("document.querySelector('[data-cost-row=\"21\"]')");
    await chrome.waitFor("document.querySelectorAll('#cost .cost-row').length === 20");
    const order = JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#cost .cost-id')].map(node => node.textContent))"));
    assert.equal(order[0], '#21', 'the newest genuine landing is first');
    assert.equal(order.at(-1), '#2', 'the twenty-first newest landing is outside the last twenty');
    for (const width of [1280, 320]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const layout = JSON.parse(await chrome.stable("JSON.stringify({text:document.querySelector('#cost').innerText,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,buttonHeight:document.querySelector('[data-cost-row=\"21\"]').getBoundingClientRect().height})"));
      assert.match(layout.text, /Private cost fixture 21/u);
      assert.match(layout.text, /—/u);
      assert.doesNotMatch(layout.text, /\$0\.00/u);
      assert.ok(layout.documentWidth <= layout.viewportWidth, `${width}px view has no horizontal page overflow`);
      assert.ok(layout.buttonHeight >= (width < 900 ? 44 : 32), `${width}px landing row remains a reachable control`);
    }
    await press(chrome, "document.querySelector('[data-cost-row=\"21\"]')");
    await chrome.waitFor("document.querySelector('#cost .cost-detail')");
    const detail = await chrome.stable("document.querySelector('#cost .cost-detail').innerText");
    assert.ok(/No usage record/u.test(detail) || /Cost\s+—/u.test(detail), 'missing or unknown usage remains a visible dash');
    const publicView = await serveFolder(publicOutput, '/public/');
    try {
      await chrome.send('Page.navigate', { url: publicView.base + '/public/#cost' });
      await chrome.waitFor("snapshot && data?.project?.items.length === 21");
      assert.equal(await chrome.stable("!!document.querySelector('[data-tab=cost]') || !!document.querySelector('#cost') || view.tab === 'cost'"), false,
        'direct Cost navigation cannot reveal a tab in the actual public snapshot');
      await chrome.stable("localStorage.setItem('snapshot.pb.tab','cost')");
      await chrome.send('Page.reload', { ignoreCache: true });
      await chrome.waitFor("snapshot && data?.project?.items.length === 21");
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
