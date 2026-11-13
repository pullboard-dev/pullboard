/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css */
/** #6927: the Gate stage is charcoal everywhere, and Roadmap marks are the design sheet's marks [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { board } from '../../logic/render/dashboard/fixture.js';
import { now } from '../../logic/render/dashboard/fixture.js';

const IO = new URL('../../../src/io/', import.meta.url);
const read = file => readFileSync(new URL(file, IO), 'utf8');
const main = read('main.css'), stage = read('stage.css'), dashboard = read('dashboard.css');

test('clause 1: --stage-gate is the sheet charcoal and every Gate dot, tile and bar takes it, never the Blocked grey [N26]', () => {
  assert.match(main, /--stage-gate: light-dark\(#1f2933, #d6dbe0\)/u, 'the token holds the sheet light and dark values');
  assert.match(dashboard, /\.dash-dot\.gate \{ background: var\(--stage-gate\); \}/u, 'the gate dot paints the token');
  assert.doesNotMatch(dashboard, /\.dash-dot\.gate \{[^}]*stage-gated/u, 'the gate dot is not the Blocked grey');
  const { project, events } = board();
  const html = dashboardHtml(dashboardModel(project, events, { now, complete: true }));
  const flow = html.match(/data-dashboard-step="gate"[^>]*><span class="dash-stage-t"><i class="dash-dot (\w+)"/u);
  assert.equal(flow?.[1], 'gate', 'the Flow Gate card carries the gate dot');
  assert.match(html, /<i class="dash-dot gate"><\/i><b>\d+<\/b>in the gate/u, 'the Now tile for the gate carries the gate dot');
  assert.doesNotMatch(html, /dash-dot gated"><\/i><b>\d+<\/b>in the gate/u, 'no gate tile is grey');
});

test('clause 2: Roadmap marks are the sheet marks: 4 px, Blocked grey chip, dashed Held with its pause, soft red Sent back; no pills or dashed word boxes [N26]', () => {
  const rows = stage.slice(stage.indexOf('.milestone-item .stage-word {'));
  assert.match(rows, /\.milestone-item \.stage-word \{[^}]*border-radius: var\(--radius-chip\)/u, 'the stage chip is 4 px');
  assert.match(rows, /\[data-stage="blocked"\] \.stage-word \{[^}]*var\(--stage-blocked-soft\)/u, 'Blocked is the grey chip');
  assert.doesNotMatch(rows, /data-stage="blocked"\] \.stage-word \{[^}]*dashed/u, 'Blocked is not a dashed box');
  assert.match(rows, /\.milestone-item \.stage-mark \{[^}]*border-radius: var\(--radius-chip\)[^}]*var\(--mark-back-soft\)/u, 'the mark is a 4 px soft red mark');
  assert.match(rows, /\.milestone-item \.stage-mark\.gate \{[^}]*border: var\(--border-dashed-strong\)/u, 'Held is dashed');
  assert.match(rows, /\.milestone-item \.stage-mark\.gate::before/u, 'Held carries its pause icon');
  assert.doesNotMatch(rows, /radius-pill/u, 'no Roadmap mark or chip is a pill');
  assert.match(main, /--mark-back-soft: light-dark\(#fbe9e7,/u, 'the soft red ground is the sheet value');
});

test('clause 2b: a long path in a Roadmap title stays on its row and ends in an ellipsis [N26]', () => {
  assert.match(stage, /\.milestone-title code\.inline\.long[^{]*\{[^}]*text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal/u);
});
