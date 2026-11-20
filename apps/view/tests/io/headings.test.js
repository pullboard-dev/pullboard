/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/cost.css apps/view/src/io/page/render.js */
/** @pullboard-world-pin reads the shipped stylesheets and renderer source to prove the page headings use only the sheet's two header levels. */
/** Cost, Settings and Items draw their headers with the two shared classes, outside their cards [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { costOverviewHtml } from '../../src/io/cost/overview.js';

const file = name => readFileSync(new URL('../../src/' + name, import.meta.url), 'utf8');

test('view.x-io-headings.clause-1-one-shared-class-per-header: clause 1: one shared class per header level, and Cost and Settings headers sit outside their cards [N26]', () => {
  const main = file('io/main.css');
  assert.match(main, /\.hd1 \{[^}]*10\.5px[^}]*uppercase/u, 'level 1: the sheet section header');
  assert.match(main, /\.hd2 \{[^}]*12\.5px[^}]*text-transform: none/u, 'level 2: the sheet sub-head');
  const cost = costOverviewHtml({ window: '7d', totals: { agentMs: 3600000, itemCount: 1 }, days: [], builders: { rows: [] }, verifiers: { rows: [] }, longest: [], allItems: 1 }, null, {});
  assert.deepEqual([...cost.matchAll(/<h2 class="hd1">([^<]*)</gu)].map(match => match[1]), ['Models', 'Agent time'], 'Cost section headers use level 1');
  assert.doesNotMatch(cost, /<h[1-4](?![^>]*class="hd[12]")/u, 'no heading on Cost has any other style');
  for (const header of cost.matchAll(/<h2 class="hd1">/gu)) {
    const before = cost.slice(0, header.index);
    assert.ok(before.lastIndexOf('<div class="shd') > before.lastIndexOf('<article') && before.lastIndexOf('<div class="shd') > before.lastIndexOf('class="cost-card'), 'the header is on the ground, above its card');
  }
  const settings = file('logic/settings/render.js');
  assert.match(settings, /<div class="shd ghead"><h2 class="hd1">/u, 'Settings group headers are level 1, above the group card');
  assert.doesNotMatch(settings, /<h[1-3]>/u, 'Settings has no unclassed heading');
  const items = file('io/page/render.js');
  assert.doesNotMatch(items, /<h3>/u, 'Items panel sub-heads are all level 2');
  for (const gone of [/\.cost-heading/u, /\.settings-head h2/u, /\.ghead h3/u, /\.detail h3 \{/u, /\.cost-sec h2/u]) assert.doesNotMatch(main + file('io/cost.css'), gone, 'the per-page heading style is gone: ' + gone);
});

test('view.x-io-headings.clause-2-cost-has-no-page-heading: clause 2: Cost has no page heading and no in-page window control [N26]', () => {
  const html = costOverviewHtml({ window: '30d', totals: {}, days: [], builders: { rows: [] }, verifiers: { rows: [] }, longest: [] }, null, {});
  assert.doesNotMatch(html, /<h1|data-cost-window|cost-periods|Today<\/button>/u);
});

test('view.x-io-headings.the-stylesheets-that-carry-the-page-headings: the stylesheets that carry the page headings are brace-balanced, so no rule swallows the ones after it [N26]', () => {
  for (const name of ['io/main.css', 'io/cost.css']) { const css = file(name); assert.equal(css.split('{').length, css.split('}').length, name + ': every block is closed'); }
});
