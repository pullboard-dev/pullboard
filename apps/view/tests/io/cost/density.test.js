/** @pullboard-test-input apps/view/src/io/cost.css apps/view/src/io/cost/overview.js */
/** @pullboard-world-pin reads cost.css to prove a role stays on one line and the Agent time bar is thin. */
/** Cost density: a role is one row, and Agent time is one dense line with a row per model and per lane [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { costOverviewHtml } from '../../../index.js';

const row = (model, label, extra) => ({ model, label, vendor: 'Vendor', ...extra });
const data = {
  version: 1, window: '7d', totals: { agentMs: 7200000, itemCount: 4, medianItemMs: 1800000, sentBack: { items: 1, itemShare: 0.25, agentMs: 1800000, agentMsShare: 0.25 } },
  days: [{ date: '2026-10-30', firstTimeMs: 5400000, sentBackMs: 1800000, items: 4 }],
  builders: { verdict: 'clear', best: 'a', runnerUp: 'b', rows: [row('a', 'Model A', { built: 40, rate: 0.8, low: 0.7, high: 0.9, judged: true }), row('b', 'Model B', { built: 35, rate: 0.5, low: 0.4, high: 0.6, judged: true })] },
  verifiers: { verdict: 'leaning', best: 'a', runnerUp: 'b', rows: [row('a', 'Model A', { accepts: 40, rate: 0.9, low: 0.8, high: 0.95, judged: true }), row('b', 'Model B', { accepts: 35, rate: 0.8, low: 0.6, high: 0.9, judged: true })] },
  byModel: [{ key: 'a', label: 'Model A', agentMs: 5400000, sentBackMs: 0, items: 3, share: 0.75, sentBackShare: 0 }, { key: 'b', label: 'Model B', agentMs: 1800000, sentBackMs: 1800000, items: 1, share: 0.25, sentBackShare: 1 }],
  byLane: [{ key: 'view', label: 'view', agentMs: 7200000, sentBackMs: 1800000, items: 4, share: 1, sentBackShare: 0.25 }],
};
const html = costOverviewHtml(data, null, {});
const text = fragment => fragment.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();

test('view.x-io-cost-density.clause-1-models-shows-one-compact-row: clause 1: Models shows one compact row per role with the best model, its rate, the runner-up, the sample, how settled it is and the advice [test,N26]', () => {
  const calls = /<div class="cost-model-calls">(.*?)<\/div><div class="cost-model-table-wrap">/su.exec(html)?.[1] ?? '';
  const rows = calls.match(/<div class="cost-verdict">.*?<\/div>(?=<div class="cost-verdict">|$)/gsu) ?? [];
  assert.equal(rows.length, 2, 'one row for building and one for verifying');
  assert.doesNotMatch(calls, /<article|cost-model-call"/u, 'no card per role');
  const [building, verifying] = rows.map(text);
  assert.match(building, /^building Model A builds best 80% pass first time over 40 items, against 50% for Model B.* Put it on your build seats\. Clear$/u);
  assert.match(verifying, /^verifying Model A verifies best 10% of what it accepted came back later, over 40 accepts\..* Keep it on most verify seats\..* Leaning$/u);
  assert.match(readFileSync(new URL('../../../src/io/cost.css', import.meta.url), 'utf8'), /\.cost-vtext \{[^}]*white-space: nowrap/u, 'a role stays on one line');
});

test('view.x-io-cost-density.clause-2-agent-time-is-one-dense: clause 2: Agent time is one dense line with its thin bar, then a row per model and per lane with hours, share and sent-back share [test,N26]', () => {
  const summary = /<article class="cost-summary">(.*?)<\/article><article class="cost-chart">/su.exec(html)?.[1] ?? '';
  const line = /<div class="cost-line">(.*?)<\/div>/su.exec(summary)?.[1] ?? '';
  assert.equal(text(line), '2.0 h 4 landed items 30 min typical item 25% of items sent back, 25% of the time · 30 min');
  assert.ok(summary.indexOf('class="cost-split"') > summary.indexOf('class="cost-line"'), 'the thin bar sits under the line');
  assert.match(readFileSync(new URL('../../../src/io/cost.css', import.meta.url), 'utf8'), /\.cost-summary \.cost-split \{ height: 4px/u, 'the bar is thin');
  const spreadRows = [...summary.matchAll(/<div class="cost-spread-row">(.*?)<\/div>(?=<div class="cost-spread-row">|<\/div>)/gsu)].map(match => text(match[1]));
  assert.deepEqual(spreadRows, ['Model A 1.5 h 75% 0%', 'Model B 30 min 25% 100%', 'view 2.0 h 100% 25%']);
  assert.deepEqual([...summary.matchAll(/<h3 class="hd2">([^<]*)</gu)].map(match => match[1]), ['By model', 'By lane']);
});
