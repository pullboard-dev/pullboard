/** The Cost view shows the coordinator's usage line when stats return it, and the word unknown when they return none [C7,#9687]. */
/** @pullboard-test-input source-cell apps/view */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOverviewHtml } from '../../src/io/cost/overview.js';

/** The model name the coordinator's fixture session reports. */
const SESSION_MODEL = ['fixture', 'coordinator'].join('-');
const base = { window: '7d', totals: { agentMs: 3600000, itemCount: 1 }, days: [], builders: { rows: [] }, verifiers: { rows: [] }, longest: [], allItems: 1 };
const line = html => html.match(/<p class="cost-unknown cost-coordinator"[^>]*>(.*?)<\/p>/u)?.[1];

test('clause 1: the Cost tab shows the coordinator usage line when stats return it [C7,#9687]', () => {
  const html = costOverviewHtml({ ...base, coordinator: { sessions: 2, inputTokens: 12000, outputTokens: 3400, models: [{ model: SESSION_MODEL }] } }, null, {});
  const said = line(html);
  assert.ok(said, 'the coordinator line is drawn');
  assert.match(said, /Coordinator usage/u);
  assert.match(said, /<b>12K<\/b> input/u);
  assert.match(said, /<b>3K<\/b> output/u);
  assert.match(said, new RegExp(SESSION_MODEL, 'u'));
  assert.doesNotMatch(said, /unknown/u);
});

test('clause 1: the Cost tab shows the word unknown when stats return no coordinator usage [C7,#9687]', () => {
  const none = { sessions: 0, inputTokens: null, outputTokens: null, models: [], unknownReasons: ['not-recorded'] };
  for (const coordinator of [none, undefined]) {
    const said = line(costOverviewHtml({ ...base, coordinator }, null, {}));
    assert.match(said, /Coordinator usage: <b>unknown<\/b>/u);
    assert.doesNotMatch(said, /\b0\b/u);
  }
});
