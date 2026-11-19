/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css */
/** #7303: Roadmap rows fit: after chips end in an ellipsis, only the chosen release lists items, a phone repeats no counts [N26]. */
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

test('view.x-io-roadmap-rows-fit.clause-2-with-three-releases-only-the: clause 2: with three releases only the next one lists its items; the others stay one line [N26]', () => {
  const html = roadmapCardsHtml([release('0.9.4', 100, 3), release('0.9.5', 200, 40), release('0.9.6', 300, 40)], { root: '/r' });
  assert.deepEqual(ids(html), ['#100', '#101', '#102'], 'no row of a closed release is drawn');
  assert.equal(html.match(/class="milestone-body"( hidden)?>/gu).filter(tag => tag.includes('hidden')).length, 2, 'the other two bodies are closed');
  assert.equal(html.match(/<section class="card-panel milestone/gu).length, 3, 'every release keeps its own line');
});

test('view.x-io-roadmap-rows-fit.clause-2-a-release-the-person-opened: clause 2: a release the person opened lists its items, and the others do not [N26]', () => {
  const open = new Map([[JSON.stringify(['/r', 'm:0.9.4']), false], [JSON.stringify(['/r', 'm:0.9.6']), true]]);
  const html = roadmapCardsHtml([release('0.9.4', 100, 3), release('0.9.5', 200, 2), release('0.9.6', 300, 2)], { root: '/r', open });
  assert.deepEqual(ids(html), ['#300', '#301']);
});

test('view.x-io-roadmap-rows-fit.clause-2-a-focused-single-release-stays: clause 2: a focused single release stays open [N26]', () => {
  assert.deepEqual(ids(roadmapCardsHtml([release('0.9.5', 200, 2)], { root: '/r', only: '0.9.5' })), ['#200', '#201']);
});

test('view.x-io-roadmap-rows-fit.clause-2-picking-a-release-in-the: clause 2: picking a release in the panel opens it and folds the rest [N26]', () => {
  const source = cockpitRoadmap({ milestoneRowHtml, readMilestoneModel, roadmapRemainingCount, roadmapCardsHtml });
  assert.match(source, /data-roadmap-jump\^="m:"\]'\)\) view\.roadmapOpen\.set\(JSON\.stringify\(\[view\.root, button\.dataset\.roadmapJump\]\), button\.dataset\.roadmapJump === key\)/u);
});

test('view.x-io-roadmap-rows-fit.clause-1-the-after-chips-share-one: clause 1: the after chips share one group that ends in an ellipsis inside the row [N26]', () => {
  const source = cockpitRoadmap({ milestoneRowHtml, readMilestoneModel, roadmapRemainingCount, roadmapCardsHtml });
  assert.match(source, /<span class="roadmap-afters">/u, 'the chips are grouped');
  const css = composeViewStyles();
  const rule = css.match(/\.milestone-item \.roadmap-afters \{([^}]*)\}/u)?.[1] ?? '';
  for (const part of ['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap', 'min-width: 0']) assert.ok(rule.includes(part), part);
});
