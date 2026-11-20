/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css */
/** #7547: the Roadmap release header sits above its card, each number once, with no pace line, Rulings box or rail count tiles [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMilestoneModel } from '../../../src/io/roadmap/render.js';
import { roadmapCardsHtml } from '../../../src/io/roadmap/render.js';
import { roadmapHeaders } from '../../../src/logic/summary/roadmap.js';
import { composeViewStyles } from '../../../src/io/styles.js';

const rows = Array.from({ length: 3 }, (_, i) => ({ label: '#' + (10 + i), why: 'row', state: 'open', stage: 'open' }));
const summary = { total: 40, landed: 25, landing: 2, review: 3, building: 4, waiting: 5, held: 1, left: 15, needsYou: [10], pace: { last6h: 12, last2h: 4 }, estimate: { low: 3, high: 5 } };
const read = readMilestoneModel({ name: '0.9.4: Speed', items: [], summary }, rows);
const headers = new Map([[read, roadmapHeaders({ targetLabels: new Map(), addresses: new Map(), root: '/r', now: Date.parse('2026-11-13T12:00:00Z'), locale: 'en-US', timeZone: 'UTC' })(read)]]);
const html = roadmapCardsHtml([read], { root: '/r', headers });

test('view.x-io-roadmap-header-clean.clause-1-the-header-is-a-sibling: clause 1: the header is a sibling above the card, led by a grey version and the bold name, with no chevron [N26]', () => {
  const section = html.match(/<section class="milestone roadmap-has-summary"[^>]*>/u);
  assert.ok(section, 'the release section is not itself a card');
  assert.doesNotMatch(section[0], /card-panel/u);
  assert.ok(html.indexOf('class="release-header"') < html.indexOf('class="milestone-body"'), 'header before the card body');
  const header = html.match(/<div class="release-header">.*?<div class="milestone-body"/su)[0];
  assert.match(header, /<span class="dash-ver">0\.9\.4<\/span>Speed/u, 'grey version, then the name');
  assert.doesNotMatch(header, /class="caret"/u, 'no collapse chevron in the header');
});

test('view.x-io-roadmap-header-clean.clause-1-one-of-count-with-thousands: clause 1: one "of" count with thousands separators, the legend with landing and square chips, and the thin bar [N26]', () => {
  const big = readMilestoneModel({ name: '0.9.4: Speed', items: [], summary: { ...summary, total: 1738, landed: 1705, left: 33, landing: 0, review: 0, building: 13, waiting: 19, held: 1 } }, rows);
  const text = roadmapCardsHtml([big], { root: '/r', headers: new Map([[big, roadmapHeaders({ targetLabels: new Map(), addresses: new Map(), root: '/r', locale: 'en-US' })(big)]]) }).replace(/<[^>]*>/gu, '|');
  assert.equal(text.match(/1,705 of 1,738 landed/gu).length, 1, 'the of-line appears once');
  assert.match(text, /33 to go/u);
  assert.match(text, /\|1,705\| \|landed\|/u, 'the legend keeps its landed count');
  assert.match(text, /\|landing\|/u);
  assert.doesNotMatch(text, /accepted, landing/u);
  assert.match(html, /class="milestone-progress roadmap-summary-bar"/u, 'the thin bar stays');
  assert.match(html, /data-summary-state="review"/u, 'the stage chip row stays');
  assert.doesNotMatch(html.replace(/<[^>]*>/gu, '|'), /25\/40/u, 'the Releases list repeats no landed count');
});

test('view.x-io-roadmap-header-clean.clause-2-no-pace-line-and-no: clause 2: no pace line and no Rulings box in the header [N26]', () => {
  assert.doesNotMatch(html, /items an hour|landed in the last|roadmap-pace|Rulings|roadmap-summary-needs|roadmap-need/u);
});

test('view.x-io-roadmap-header-clean.clause-3-the-rail-lists-releases-only: clause 3: the rail lists releases only, with no count tiles [N26]', () => {
  const rail = html.match(/<aside.*?<\/aside>/su)[0];
  assert.match(rail, /roadmap-release-index/u);
  assert.doesNotMatch(rail, /roadmap-stage-counts|roadmap-shipping|roadmap-last-shipped|data-shipping-stage/u);
  assert.doesNotMatch(html, /roadmap-mobile-shipping|roadmap-stage-counts/u);
  assert.doesNotMatch(composeViewStyles(), /\.roadmap-stage-counts|\.roadmap-summary-needs/u, 'the dead rules are gone');
});
