/**
 * #7303: Roadmap rows fit: after chips end in an ellipsis, only the chosen release lists items, a phone repeats no counts [N26].
 * @pullboard-test-input apps/view/src/io/stage.css apps/view/src/io/main.css apps/view/src/io/roadmap/render.js apps/view/src/logic/summary/roadmap.js apps/view/src/io/styles.js apps/view/src/io/cockpit/roadmap.js
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMilestoneModel } from '../../../src/io/roadmap/render.js';
import { roadmapCardsHtml } from '../../../src/io/roadmap/render.js';
import { composeViewStyles } from '../../../src/io/styles.js';
import { cockpitRoadmap } from '../../../index.js';
import { milestoneRowHtml } from '../../../index.js';
import { roadmapRemainingCount } from '../../../index.js';
import { roadmapSummary } from '../../../src/logic/summary/roadmap.js';

const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ label: '#' + (from + i), why: 'row ' + (from + i), state: 'open', stage: 'open' }));
const release = (name, from, n) => readMilestoneModel({ name, items: [], summary: { total: n, landed: 0, left: n } }, rows(from, n));
const ids = text => [...text.matchAll(/<span class="id">(#\d+)<\/span>/gu)].map(([, id]) => id);

test('clause 2: with three releases only the next one lists its items; the others stay one line [N26]', () => {
  const html = roadmapCardsHtml([release('0.9.4', 100, 3), release('0.9.5', 200, 40), release('0.9.6', 300, 40)], { root: '/r' });
  assert.deepEqual(ids(html), ['#100', '#101', '#102'], 'no row of a closed release is drawn');
  assert.equal(html.match(/class="milestone-body"( hidden)?>/gu).filter(tag => tag.includes('hidden')).length, 2, 'the other two bodies are closed');
  assert.equal(html.match(/<section class="card-panel milestone/gu).length, 3, 'every release keeps its own line');
});

test('clause 2: a release the person opened lists its items, and the others do not [N26]', () => {
  const open = new Map([[JSON.stringify(['/r', 'm:0.9.4']), false], [JSON.stringify(['/r', 'm:0.9.6']), true]]);
  const html = roadmapCardsHtml([release('0.9.4', 100, 3), release('0.9.5', 200, 2), release('0.9.6', 300, 2)], { root: '/r', open });
  assert.deepEqual(ids(html), ['#300', '#301']);
});

test('clause 2: a focused single release stays open [N26]', () => {
  assert.deepEqual(ids(roadmapCardsHtml([release('0.9.5', 200, 2)], { root: '/r', only: '0.9.5' })), ['#200', '#201']);
});

test('clause 2: picking a release in the panel opens it and folds the rest [N26]', () => {
  const source = cockpitRoadmap({ milestoneRowHtml, readMilestoneModel, roadmapRemainingCount, roadmapCardsHtml });
  assert.match(source, /data-roadmap-jump\^="m:"\]'\)\) view\.roadmapOpen\.set\(JSON\.stringify\(\[view\.root, button\.dataset\.roadmapJump\]\), button\.dataset\.roadmapJump === key\)/u);
});

test('clause 1: the after chips share one group that ends in an ellipsis inside the row [N26]', () => {
  const source = cockpitRoadmap({ milestoneRowHtml, readMilestoneModel, roadmapRemainingCount, roadmapCardsHtml });
  assert.match(source, /<span class="roadmap-afters">/u, 'the chips are grouped');
  const css = composeViewStyles();
  const rule = css.match(/\.milestone-item \.roadmap-afters \{([^}]*)\}/u)?.[1] ?? '';
  for (const part of ['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap', 'min-width: 0']) assert.ok(rule.includes(part), part);
});

test('clause 3: the Rulings line has no comma text, each ruling is its own one-line element [N26]', () => {
  const summary = { total: 10, left: 6, landed: 4, landing: 0, review: 0, building: 0, waiting: 0, held: 0, needsYou: [1, 2, 3] };
  const { detail } = roadmapSummary({ name: 'M', summary }, {});
  const line = detail.match(/<div class="roadmap-summary-needs">.*?<\/div>/u)[0];
  assert.equal(line.match(/class="roadmap-need"/gu).length, 3);
  assert.doesNotMatch(line.replace(/<[^>]*>/gu, '|'), /,/u, 'no comma separators to strand on a line');
  assert.match(composeViewStyles(), /\.roadmap-need \{[^}]*white-space: nowrap/u);
});

test('clause 3: at phone width the counts are not repeated under the header legend [N26]', () => {
  const read = release('0.9.4', 100, 3);
  const headers = new Map([[read, { top: '<h2>0.9.4</h2>', detail: '<div class="roadmap-summary">legend</div>' }]]);
  read.milestone.summary = { ...read.milestone.summary, landed: 0, landing: 0, review: 0, building: 0, waiting: 0, held: 0 };
  const html = roadmapCardsHtml([read], { root: '/r', headers });
  const mobile = html.match(/<section class="roadmap-shipping roadmap-mobile-shipping".*?<\/section>/su)[0];
  assert.doesNotMatch(mobile, /roadmap-stage-counts/u, 'the phone section holds no count tiles');
  assert.match(mobile, /Last shipped/u);
  assert.match(html.match(/<section class="roadmap-shipping roadmap-desktop-shipping".*?<\/section>/su)[0], /roadmap-stage-counts/u, 'the desktop panel keeps them');
});
