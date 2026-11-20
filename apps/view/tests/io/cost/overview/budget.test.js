/** The Cost overview draws the machine budget state as one line [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOverviewHtml } from '../../../../index.js';

test('view.io-cost-overview-budget.the-cost-overview-shows-the-budget-warning: the cost overview shows the budget warning for a warn or stop state and nothing when the budget is absent [N26]', () => {
  const warn = costOverviewHtml({ budget: { state: 'warn', spend: 7, limit: 8, which: 'dailyUsd' } });
  assert.equal(warn.match(/data-cost-budget/g).length, 1);
  assert.match(warn, /class="[^"]*cost-budget-warn[^"]*" data-cost-budget>[^<]*<b>\$7\.00<\/b> of <b>\$8\.00<\/b> daily/);
  const stop = costOverviewHtml({ budget: { state: 'stop', spend: 9, limit: 8, which: 'dailyUsd' } });
  assert.match(stop, /cost-budget-stop/);
  assert.doesNotMatch(costOverviewHtml({}), /data-cost-budget/);
});
