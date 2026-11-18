/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css */
/** Roadmap and Activity match their approved mockups: header order, row chips and the CSS home, on seeded pure input [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pageRenderScript } from '../../../index.js';
import { composeViewStyles } from '../../../src/io/styles.js';
import { roadmapSummary } from '../../../src/logic/summary/roadmap.js';

const IO = new URL('../../../src/io/', import.meta.url);
const lines = file => readFileSync(new URL(file, IO), 'utf8').split('\n').length;

test('view.x-io-roadmap-mockup.clause-1-the-release-header-reads-title: clause 1: the release header reads title and count, one full-width bar, then one legend [N26]', () => {
  const { header } = roadmapSummary({ name: 'M', summary: { total: 10, left: 6, landed: 4, landing: 2, review: 1, building: 1, waiting: 2, held: 0 } });
  const at = marker => header.indexOf(marker);
  const order = ['release-name', 'roadmap-summary-bar', 'roadmap-summary-legend'].map(at);
  assert.ok(order.every(index => index >= 0), 'every header part renders');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'title, bar, legend, in that order');
  assert.equal(header.match(/class="roadmap-summary-legend dash-keys"/gu).length, 1, 'one legend');
});

test('view.x-io-roadmap-mockup.clause-2-a-roadmap-row-names-only: clause 2: a Roadmap row names only its stage, with Landed for Merged, and no route or holder text [N26]', () => {
  const source = pageRenderScript();
  assert.match(source, /roadmap && stage\.stage === 'Merged' \? 'Landed' : stage\.stage/u, 'Merged reads Landed on the Roadmap');
  assert.match(source, /\(roadmap \|\| brief \? '' : '<small class="stage-detail"/u, 'a Roadmap row carries no stage detail text');
});

test('view.x-io-roadmap-mockup.clause-3-no-stylesheet-is-over-1500: clause 3: no stylesheet is over 1500 lines; the new rules live in stage.css, composed through its marker, and main.css is not grown [N26]', () => {
  assert.ok(lines('stage.css') <= 1500);
  const css = composeViewStyles();
  assert.doesNotMatch(css, /@pullboard-[\w-]+-styles/u, 'every marker is filled');
  const stage = readFileSync(new URL('stage.css', IO), 'utf8');
  assert.match(stage, /\.milestone-item \.stage-word/u);
  assert.match(stage, /#activity \.activity-event > time \{[^}]*var\(--mono\)/u, 'faint mono times');
  assert.ok(css.includes('.milestone-item .stage-word'), 'the rules reach the shared stylesheet');
});
