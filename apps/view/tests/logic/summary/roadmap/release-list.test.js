/** @pullboard-test-input apps/view/src/io/main.css */
/** #6842: the Roadmap's Releases list is one compact row per release, marked like the navigation marks its page [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readMilestoneModel } from '../../../../src/io/roadmap/render.js';
import { roadmapCardsHtml } from '../../../../src/io/roadmap/render.js';

const IO = new URL('../../../../src/io/', import.meta.url);
const css = readFileSync(new URL('main.css', IO), 'utf8');
const rule = selector => css.split('\n').find(line => line.startsWith(selector + ' {')) ?? '';
const summary = { total: 40, landed: 20, landing: 4, review: 3, building: 5, waiting: 6, held: 2, left: 20 };
const releases = [
  readMilestoneModel({ name: '0.9.4: Restructure for Speed and Cost, with a name far longer than the row', items: [], summary }, [{ label: '#1', why: 'x', state: 'open', stage: 'open' }]),
  readMilestoneModel({ name: '0.9.4-UI: Screens Match Their Mockups', items: [] }, [{ label: '#2', why: 'y', state: 'open', stage: 'open' }]),
  readMilestoneModel({ name: 'Backlog', items: [] }, [{ label: '#3', why: 'z', state: 'open', stage: 'open' }]),
];
const html = roadmapCardsHtml(releases, { root: '/r' });
const buttons = [...html.matchAll(/<button class="roadmap-release"[^>]*>.*?<\/button>/gu)].map(([text]) => text);

test('view.x-summary-roadmap-release-list.clause-1-each-release-is-one-row: clause 1: each release is one row with its full version, its whole name for the CSS to cut, landed/total and a stage-coloured bar [N26]', () => {
  assert.equal(buttons.length, 3, 'one row per release');
  assert.match(buttons[0], /roadmap-release-version">0\.9\.4<\/span><span class="roadmap-release-name">Restructure for Speed and Cost, with a name far longer than the row<\/span>/u, 'the version is whole and the name is never cut in the markup');
  assert.match(buttons[1], /roadmap-release-version">0\.9\.4-UI<\/span>/u, 'a suffixed version stays whole');
  assert.match(buttons[2], /roadmap-release-version">Backlog<\/span><span class="roadmap-release-name"><\/span>/u, 'a release with no version is one word');
  assert.doesNotMatch(buttons[0], /<b>/u, 'the landed count lives in the release header alone');
  for (const part of ['landed', 'landing', 'review', 'building', 'waiting', 'held']) assert.match(buttons[0], new RegExp('<rect class="' + part + '" x="'), 'the bar has a ' + part + ' segment');
  assert.match(buttons[0], /viewBox="0 0 40 1"/u, 'the bar is drawn over the release total');
  assert.match(rule('.roadmap-release-name'), /overflow: hidden; text-overflow: ellipsis; white-space: nowrap/u, 'the name ends in an ellipsis at the row width');
  assert.match(rule('.roadmap-release-progress'), /height: 3px/u, 'the bar is thin');
  assert.match(css, /\.roadmap-release-progress \.landed \{ fill: var\(--stage-merged\); \}/u);
  assert.match(css, /\.roadmap-release-progress \.review \{ fill: var\(--stage-review\); \} \.roadmap-release-progress \.building \{ fill: var\(--stage-building\); \}/u);
  assert.doesNotMatch(rule('.roadmap-release'), /min-height: var\(--tap\)|box-shadow/u, 'the row is not a tall tap box');
});

test('view.x-summary-roadmap-release-list.clause-2-the-selected-release-is-marked: clause 2: the selected release is marked as the navigation marks its page, with no raised box and no grey hover box [N26]', () => {
  const selected = rule('.roadmap-release[aria-current="location"]');
  assert.match(selected, /font-weight: 600/u);
  assert.doesNotMatch(selected, /background|border|shadow/u, 'no box on the selected release');
  assert.match(rule('.roadmap-release[aria-current="location"] .roadmap-release-version::before'), /width: 5px; height: 5px;[^}]*background: var\(--accent\)/u, 'the nav\'s accent dot');
  assert.doesNotMatch(rule('.roadmap-release:hover'), /background/u, 'hover changes the ink only');
  assert.doesNotMatch(css, /\.roadmap-release:hover, \.roadmap-release\[aria-current/u);
});
