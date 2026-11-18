/** @pullboard-test-input apps/view/src/io/cost.css apps/view/src/io/main.css apps/view/src/io/cost/overview.js */
/** @pullboard-world-pin reads cost.css and main.css to prove the width rules the page ships. */
/** Cost draws its frame and last known numbers at once, and Cost and Settings use the page's full width [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { costOverviewHtml } from '../../../src/io/cost/overview.js';
import { pageScriptPart3 } from '../../../src/io/page/boards.js';

const css = name => readFileSync(new URL('../../../src/io/' + name, import.meta.url), 'utf8');

/** The page script's Cost reader and pane, run against a request that never answers and an in-memory keep(). */
function costPage(stored = {}) {
  const script = pageScriptPart3({ applyStateDelta: function applyStateDelta() {}, deriveMilestoneForecasts: function deriveMilestoneForecasts(state) { return state; }, expandItemSummaries: function expandItemSummaries() {}, costPrices: null, costTabScript: () => '', privateCost: true });
  const names = ['privateCost', 'snapshot', 'hosted', 'readOnly', 'data', 'view', 'keep', 'api', 'boardPath', 'render', 'modelTables', 'costOverviewHtml'];
  const kept = new Map(Object.entries(stored));
  const calls = { api: 0, render: 0 };
  const values = [true, false, {}, false, { projects: [{ root: '/repo', ok: true, id: 'b1' }] }, { root: '/repo', tab: 'cost', costWindow: '7d' },
    (name, value) => { if (value === undefined) return kept.get(name) ?? null; kept.set(name, value); return value; },
    () => { calls.api += 1; return new Promise(() => {}); }, root => '/boards/' + root, () => { calls.render += 1; }, { vendorClasses: [] }, costOverviewHtml];
  const page = new Function(...names, script + '\nreturn { readCostHistory, costPaneHtml };')(...values);
  return { ...page, kept, calls };
}

test('view.x-io-cost-frame.clause-1-cost-with-nothing-read-yet: clause 1: Cost with nothing read yet draws its frame at once, with no heading and no period buttons of its own, not a blank Loading page [N26]', () => {
  const { readCostHistory, costPaneHtml, calls } = costPage();
  const html = costPaneHtml(readCostHistory({ sequence: 1, events: [] }), {});
  assert.equal(calls.api, 1, 'the read starts');
  assert.match(html, /class="cost-page"[^]*Only you see this/u, 'the frame is there');
  assert.doesNotMatch(html, /<h1|data-cost-window/u, 'Cost has no page heading and no in-page window control; the window lives in the strip');
  assert.match(html, /class="cost-card cost-waiting" role="status">Reading cost history…/u, 'the numbers say they are on their way, in place');
  assert.doesNotMatch(html, /Loading cost history/u, 'no blank loading page');
});

test('view.x-io-cost-frame.clause-1-cost-draws-the-last-numbers: clause 1: Cost draws the last numbers this browser read while the fresh read is on its way [N26]', () => {
  const last = { window: '7d', totals: { agentMs: 7_200_000, itemCount: 12 }, days: [], builders: { rows: [] }, verifiers: { rows: [] }, longest: [], allItems: 12 };
  const { readCostHistory, costPaneHtml, calls } = costPage({ 'pb.cost./repo\n7d': JSON.stringify(last) });
  const html = costPaneHtml(readCostHistory({ sequence: 1, events: [] }), {});
  assert.equal(calls.api, 1, 'a fresh read still starts');
  assert.match(html, /<b class="cost-total">2\.0 h<\/b>/u, 'the remembered agent time is drawn at once');
  assert.match(html, /class="cap2 cost-updating" role="status">Updating…/u, 'and says it is updating');
  assert.doesNotMatch(html, /cost-waiting|Loading cost history/u);
  assert.doesNotMatch(costOverviewHtml(last, null, { updating: false }), /cost-updating/u, 'a settled page says nothing');
});

test('view.x-io-cost-frame.clause-2-cost-and-settings-take-the: clause 2: Cost and Settings take the page width [N26]', () => {
  assert.doesNotMatch(css('cost.css'), /\.cost-page\s*\{[^}]*max-width/u, 'Cost has no width cap');
  assert.doesNotMatch(css('main.css'), /#settings-pane\s*\{[^}]*(?:max-width|margin-inline)/u, 'Settings has no width cap and is not centred');
});

const panelData = { window: '7d', totals: { agentMs: 7_200_000, itemCount: 2, medianItemMs: 3_600_000, sentBack: { itemShare: 0.5, agentMsShare: 0.5, agentMs: 3_600_000 } }, days: [{ date: '2026-10-30', firstTimeMs: 3_600_000, sentBackMs: 3_600_000, items: 2 }], builders: { rows: [] }, verifiers: { rows: [] }, longest: [], allItems: 2 };

test('view.x-io-cost-frame.clause-1-cost-shows-no-line-about: clause 1: Cost shows no line about agent time or adding model prices [N26]', () => {
  for (const hasPrices of [false, true]) assert.doesNotMatch(costOverviewHtml(panelData, null, { hasPrices }), /Showing agent time|Want dollars|Add model prices|cost-prices|data-cost-copy/u);
});

test('view.x-io-cost-frame.clause-2-agent-time-and-agent-time: clause 2: Agent time and Agent time each day share one panel under one level-1 header, below Models, summary beside the chart at equal height [N26]', () => {
  const html = costOverviewHtml(panelData);
  const panel = /<h2 class="hd1">Agent time<\/h2><\/div><div class="cost-card cost-overview">(.*?)<\/div><\/section><\/section>$/su.exec(html)?.[1] ?? '';
  assert.match(panel, /^<article class="cost-summary">/u, 'the summary opens the panel');
  assert.match(panel, /<article class="cost-chart"><div class="cost-chart-head"><h3 class="hd2">Agent time each day<\/h3>/u, 'the daily chart sits in the same panel under a level-2 head');
  assert.equal(panel.match(/<h2/gu), null, 'no second level-1 header inside the panel');
  assert.match(css('cost.css'), /\.cost-overview\s*\{[^}]*display: grid;[^}]*align-items: stretch/u, 'the two sides stretch to one height');
  assert.doesNotMatch(css('cost.css'), /\.cost-summary\s*\{[^}]*align-self: start/u, 'the summary is not shortened beside the chart');
});

test('view.x-io-cost-frame.clause-1-an-opened-item-scrolls-to: clause 1: an opened item scrolls to just below the two-row phone nav, so its chips are not cut under it [N26]', () => {
  const top = Number(/#detail \{ scroll-margin-top: (\d+)px; \}/u.exec(css('main.css'))?.[1]);
  assert.ok(top >= 88, 'the margin clears the sticky two-row nav (about 72 px) with room for a gap, not the old 60 px');
});
