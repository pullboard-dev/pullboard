/** The Cost page's order: Models near the top, no Took the longest, Agent time each day lower [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOverviewHtml } from '../../../index.js';

const data = { version: 1, window: '7d', totals: { agentMs: 7200000, itemCount: 2, medianItemMs: 3600000, sentBack: { itemShare: 0.5, agentMsShare: 0.6, agentMs: 1000 } }, days: [{ date: '2026-10-30', firstTimeMs: 3600000, sentBackMs: 3600000, items: 2 }], builders: { rows: [] }, verifiers: { rows: [] }, longest: [{ id: 1, title: 'Long item', agentMs: 9, sessions: [] }], allItems: 2 };
const html = costOverviewHtml(data, null, {});

test('view.x-io-cost-order.clause-1-the-models-section-sits-above: clause 1: the Models section sits above the per-day section on Cost [test,N26]', () => {
  assert.ok(html.indexOf('>Models</h2>') > 0, 'Models is shown');
  assert.ok(html.indexOf('>Models</h2>') < html.indexOf('Agent time each day'), 'Models comes before Agent time each day');
  assert.ok(html.indexOf('>Models</h2>') < html.indexOf('cost-chart-plot'), 'and before the chart');
});

test('view.x-io-cost-order.clause-2-cost-no-longer-shows-the: clause 2: Cost no longer shows the Took the longest section, even when the data holds longest items [test,N26]', () => {
  assert.doesNotMatch(html, /Took the longest|cost-longest|data-cost-row|data-cost-all/u);
});

test('view.x-io-cost-order.clause-3-agent-time-each-day-is: clause 3: Agent time each day is the last section, below the cost sections [test,N26]', () => {
  assert.ok(html.indexOf('Agent time each day') > html.indexOf('cost-model-table'), 'below the model table');
  assert.ok(html.indexOf('class="cost-chart"') > html.lastIndexOf('class="cost-card'), 'it sits inside the last card, and no card follows it');
});
