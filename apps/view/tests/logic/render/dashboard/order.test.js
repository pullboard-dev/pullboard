/** Clause 1 of #6847: the Dashboard draws the approved /live-style mockup's sections in its order [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { board } from './fixture.js';
import { now } from './fixture.js';

/** One section's markup, by its label. */
function section(html, name) {
  const start = html.indexOf(`aria-label="${name}"`);
  assert.notEqual(start, -1, `${name} renders`);
  return html.slice(start, html.indexOf('</section>', start));
}

test('view.x-render-dashboard-order.clause-3-how-work-moved-now-release: clause 3: How work moved, Now, Release, the pace strip, Agents, the four lists, Your lanes and Runners, in order [N26]', () => {
  const { project, events } = board();
  const html = dashboardHtml(dashboardModel(project, events, { now, complete: true }));
  const order = [...html.matchAll(/<section class="[^"]*" (?:id="[^"]*" )?aria-label="([^"]+)"/gu)].map(([, name]) => name);
  assert.deepEqual(order, ['How work moved', 'Now', 'Release', 'Pace and agent time', 'Agents', 'In the gate', 'In review', 'Landing', 'Landed · 4 h', 'Your lanes', 'Runners']);
  assert.doesNotMatch(html, /dash-hero|aria-label="Rulings"|The last two hours|window-comparison/u, 'the old hero, Rulings card and comparison are gone');

  // How work moved: Build, Gate, Review, Land, each with its four-hour rate.
  const flow = section(html, 'How work moved');
  const cards = [...flow.matchAll(/data-dashboard-step="(\w+)"[^>]*><span class="dash-stage-t"><i class="dash-dot \w+"><\/i>(\w+)<span class="dash-rate[^"]*">([^<]+)<\/span><\/span><span class="dash-stage-a">(.*?)<\/span><span class="dash-stage-b">/gu)]
    .map(([, key, name, rate, line]) => [key, name, rate, line.replace(/<[^>]+>/gu, '')]);
  assert.deepEqual(cards, [
    ['build', 'Build', '1/h', '3 claimed → 2 submitted'],
    ['gate', 'Gate', '1/h', '1 green · 1 red'],
    ['review', 'Review', '1/h', '1 accepted · 1 sent back'],
    ['land', 'Land', '0/h', '1 landed · 1 to land'],
  ]);
  assert.match(flow, /1 sent back<\/button> to their builders in the last 4 hours/u, 'the reject five hours ago is outside the window');

  // The Now line: where every item is, one number per stage.
  const nowLine = [...section(html, 'Now').matchAll(/<b>(\d+)<\/b>([^<]+)<\/button>/gu)].map(([, n, word]) => word + ' ' + n);
  assert.deepEqual(nowLine, ['ready 3', 'blocked 1', 'building 1', 'in the gate 1', 'in review 1', 'to land 1', 'sent back 1', 'held 1']);

  assert.match(section(html, 'Release'), /<span class="dash-ver">0\.1\.0<\/span>First release/u);
  assert.match(section(html, 'Pace and agent time'), /Landed per hour[\s\S]*Agent time/u);

  // Agents: one line per agent, with its thin timeline, its stage chip and its numbers.
  const agents = section(html, 'Agents');
  const rows = [...agents.matchAll(/<tr data-dashboard-agent="([^"]+)">([\s\S]*?)<\/tr>/gu)];
  assert.deepEqual(rows.map(([, id]) => id), ['web-1', 'tests-1']);
  for (const [, id, row] of rows) {
    assert.match(row, new RegExp(`<svg class="dash-lane"[^>]*aria-label="${id} last four hours"`, 'u'), id + ' has a timeline');
    assert.equal([...row.matchAll(/class="dash-num/gu)].length, 4, id + ' has Build, Review, Idle and Shouts');
  }
  assert.match(rows[0][2], /<button type="button" class="dash-chip b" data-go="item:4"><span>#4<\/span>building 40m<\/button>/u);
  assert.match(rows[1][2], /class="dash-chip r" data-go="item:5"><span>#5<\/span>reviewing 20m/u);

  // The four lists and the lanes.
  assert.match(section(html, 'In the gate'), /data-go="item:6"/u);
  assert.match(section(html, 'In review'), /data-go="item:5"[\s\S]*reviewing 20m/u);
  assert.match(section(html, 'Landing'), /data-go="item:7"/u);
  assert.match(section(html, 'Landed · 4 h'), /data-go="item:8"[\s\S]*1h|data-go="item:8"[\s\S]*60m/u);
  const lanes = [...section(html, 'Your lanes').matchAll(/<td class="ln">(\w+)<\/td>/gu)].map(([, lane]) => lane);
  assert.deepEqual(lanes, ['web', 'tests'], 'the board lanes with work, never the coordinator');
  assert.match(section(html, 'Runners'), /Runner 1[\s\S]*Runner 2/u);
});
