/** @pullboard-test-gui */
/** Private cost presentation and actual local-board rendering; synthetic prices are presenter-only [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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

test('the authenticated local view shows a landed board item while its static export omits Cost [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the private Cost view journey.');
  const box = machine(), alpha = project(box, 'cost-tab', SPEC);
  box.run(alpha.repo, 'add', 'web', 'Private cost fixture', '--specs', 'G1', '--criterion', 'The private view shows its landed row.');
  const id = 1;
  build(box, alpha, id, 'cost-fixture.txt');
  accept(box, alpha, id);
  box.git(alpha.repo, 'merge', '--no-ff', '--no-edit', alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
  box.run(alpha.repo, 'merged', String(id), box.git(alpha.repo, 'rev-parse', 'HEAD'));
  const exported = box.exportSnapshot(alpha.repo, 'cost-static-export');
  const exportedHtml = exported.readFile(join(exported.root, 'index.html')).toString('utf8');
  assert.doesNotMatch(exportedHtml, /data-tab="cost"|id="cost"/u, 'static public exports have no Cost controls or detail');
  assert.doesNotMatch(exportedHtml, /costTabModel|freshInputTokens|cacheWriteInputTokens/u, 'private accounting code and token details are not exported');

  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-cost-tab-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.items?.some(item => item.id === 1)");
    await press(chrome, "document.querySelector('[data-tab=cost]')");
    await chrome.waitFor("document.querySelector('[data-cost-row=\"1\"]')");
    for (const width of [1280, 320]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const layout = JSON.parse(await chrome.stable("JSON.stringify({text:document.querySelector('#cost').innerText,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,buttonHeight:document.querySelector('[data-cost-row=\"1\"]').getBoundingClientRect().height})"));
      assert.match(layout.text, /Private cost fixture/u);
      assert.match(layout.text, /—/u);
      assert.doesNotMatch(layout.text, /\$0\.00/u);
      assert.ok(layout.documentWidth <= layout.viewportWidth, `${width}px view has no horizontal page overflow`);
      assert.ok(layout.buttonHeight >= (width < 900 ? 44 : 32), `${width}px landing row remains a reachable control`);
    }
    await press(chrome, "document.querySelector('[data-cost-row=\"1\"]')");
    await chrome.waitFor("document.querySelector('#cost .cost-detail')");
    const detail = await chrome.stable("document.querySelector('#cost .cost-detail').innerText");
    assert.ok(/No usage record/u.test(detail) || /Cost\s+—/u.test(detail), 'missing or unknown usage remains a visible dash');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
