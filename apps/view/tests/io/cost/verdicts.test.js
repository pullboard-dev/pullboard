/** @pullboard-test-input apps/view/src/io/cost.css apps/view/src/io/cost/overview.js */
/** @pullboard-world-pin reads cost.css to prove the verdict rows carry no fill and no nested card. */
/** Cost Models verdicts are one-line rows inside the Models panel, with no banner about unrecorded models [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { costOverviewHtml } from '../../../src/io/cost/overview.js';

const css = readFileSync(new URL('../../../src/io/cost.css', import.meta.url), 'utf8');
const row = (model, rest) => ({ model, ...rest });
const rows = [row('a', { label: 'Model A', vendor: 'v', built: 31, rate: 0.8, low: 0.6, high: 0.9, typicalItemMs: 3_600_000, judged: true }), row('b', { label: 'Model B', vendor: 'v', built: 30, rate: 0.7, low: 0.5, high: 0.9, judged: true })];
const data = { window: '7d', totals: { itemCount: 3 }, days: [], builders: { verdict: 'leaning', best: 'a', runnerUp: 'b', rows }, verifiers: { verdict: 'clear', best: 'a', rows: [row('a', { label: 'Model A', vendor: 'v', accepts: 31, verdicts: 35, rate: 0.1, low: 0.05, high: 0.2, judged: true })] }, unknownBuilderModelShare: 0.81, longest: [], allItems: 3 };

test('view.x-io-cost-verdicts.clause-1-the-building-and-verifying-verdicts: clause 1: the building and verifying verdicts are one-line rows in the Models panel, no nested cards, no grey fill [N26]', () => {
  const html = costOverviewHtml(data);
  const panel = /<div class="cost-card cost-model-card">(.*?)<table/su.exec(html)?.[1] ?? '';
  assert.equal(panel.match(/class="cost-verdict"/gu)?.length, 2, 'one row each for building and verifying');
  assert.doesNotMatch(panel, /<article|cost-model-call\b|cost-card/u, 'no card inside the panel');
  assert.match(panel, /Model A builds best<\/span><\/p><span class="cost-vtext"[^>]*><b>80%<\/b> pass first time over <b>31<\/b> items, against <b>70%<\/b> for Model B\./u, 'the wording is kept');
  assert.match(panel, /Model A verifies best/u);
  assert.doesNotMatch(css, /\.cost-confidence/u, 'no confidence chip');
  assert.doesNotMatch(css, /\.cost-verdict\s*\{[^}]*(?:background|border-radius)/u, 'the row carries no fill or card shape');
  assert.match(css, /\.cost-vtext\s*\{[^}]*white-space: nowrap/u, 'the verdict text never wraps on a wide screen');
});

test('view.x-io-cost-verdicts.clause-2-the-models-section-shows-no: clause 2: the Models section shows no banner about items that do not record their model [N26]', () => {
  assert.doesNotMatch(costOverviewHtml(data), /record which model|cost-gapnote/u);
});

test('view.x-io-cost-verdicts.clause-3-the-model-table-below-the: clause 3: the model table below the verdicts is unchanged [N26]', () => {
  const html = costOverviewHtml(data);
  assert.match(html, /<table class="cost-model-table"><thead><tr><th class="grp-gap"><\/th><th colspan="3" class="grp">Building<\/th><th colspan="2" class="grp vsep">Verifying<\/th><\/tr><tr><th>Model<\/th><th>Built<\/th><th>Passed first time <span class="sm">· bar shows likely range<\/span><\/th><th>Typical item<\/th><th class="vsep">Verdicts<\/th><th>Accepted, came back later<\/th><\/tr><\/thead><tbody><tr><th scope="row"><span class="cost-model-name">/u);
});
