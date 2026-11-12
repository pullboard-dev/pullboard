/** @pullboard-test-input source-tree */
/** Roadmap and Activity match their approved mockups: header order, row chips and the CSS home, on seeded pure input [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pageRenderScript } from '../../../index.js';
import { composeViewStyles } from '../../../src/io/styles.js';
import { roadmapSummary } from '../../../src/logic/summary/roadmap.js';

const IO = new URL('../../../src/io/', import.meta.url);
const lines = file => readFileSync(new URL(file, IO), 'utf8').split('\n').length;

test('clause 1: the release header reads title, rate line, one full-width bar, then one legend [N26]', () => {
  const { header } = roadmapSummary({ name: 'M', summary: { total: 10, left: 6, landed: 4, landing: 2, review: 1, building: 1, waiting: 2, held: 0 } });
  const at = marker => header.indexOf(marker);
  const order = ['release-name', 'roadmap-forecast', 'roadmap-summary-bar', 'roadmap-summary-legend'].map(at);
  assert.ok(order.every(index => index >= 0), 'every header part renders');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'title, rate line, bar, legend, in that order');
  assert.equal(header.match(/class="roadmap-summary-legend"/gu).length, 1, 'one legend');
});

test('clause 2: a Roadmap row names only its stage, with Landed for Merged, and no route or holder text [N26]', () => {
  const source = pageRenderScript();
  assert.match(source, /roadmap && stage\.stage === 'Merged' \? 'Landed' : stage\.stage/u, 'Merged reads Landed on the Roadmap');
  assert.match(source, /\(roadmap \? '' : '<small class="stage-detail"/u, 'a Roadmap row carries no stage detail text');
});

test('clause 3: no stylesheet is over 1500 lines; roadmap.css holds the new rules and is composed last [N26]', () => {
  assert.ok(lines('roadmap.css') <= 1500 && lines('stage.css') <= 1500);
  const css = composeViewStyles();
  const roadmap = readFileSync(new URL('roadmap.css', IO), 'utf8').trimEnd();
  assert.ok(css.endsWith(`${roadmap}\n`), 'the roadmap rules come last in the composed sheet so they win');
  assert.match(roadmap, /\.milestone-item \.stage-word/u);
  assert.match(roadmap, /\.activity-event > time \{[^}]*var\(--mono\)/u, 'faint mono times');
});
