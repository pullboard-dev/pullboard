/** Pure populated Dashboard HTML from deterministic data; native wiring remains in the audit journey [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardData } from '../../fixtures/cockpit/data.js';

/** Extract a single named Dashboard section so row and footer assertions stay scoped. */
function section(html, name) {
  const start = html.indexOf(`aria-label="${name}"`);
  assert.notEqual(start, -1, `Dashboard renders ${name}`);
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, `${name} section closes`);
  return html.slice(start, end);
}


test('Dashboard time and number labels depend on supplied locale and zone, not the test host [N26,C7]', () => {
  const input = dashboardData({ populated: true });
  const model = dashboardModel(input.project, input.events, { now: input.clockBase, complete: true });
  const before = JSON.stringify(model);
  const utc = dashboardHtml(model, { locale: 'en-GB', timeZone: 'UTC' });
  const tokyo = dashboardHtml(model, { locale: 'en-GB', timeZone: 'Asia/Tokyo' });
  assert.match(section(utc, 'Release'), /ETA<\/span><span class="dash-stat-v"><b>2–4 h<\/b><\/span><small>Wednesday, around 14:00 to 16:00<\/small>/u);
  assert.match(section(tokyo, 'Release'), /ETA<\/span><span class="dash-stat-v"><b>2–4 h<\/b><\/span><small>Wednesday, around 23:00 to Thursday 1:00<\/small>/u, 'the same estimate on the Tokyo clock crosses midnight');
  assert.match(section(utc, 'Pace and agent time'), /<title>11:00: \d+ landed<\/title>/u);
  assert.match(section(tokyo, 'Pace and agent time'), /<title>20:00: \d+ landed<\/title>/u);
  assert.match(section(utc, 'Agents'), /<th>8:00 → now<\/th>/u, 'the timeline axis starts four hours back on the reader clock');
  assert.equal(dashboardHtml(model), dashboardHtml(model, { locale: 'en-US', timeZone: 'UTC' }), 'omitted preferences have deterministic defaults');
  assert.equal(JSON.stringify(model), before, 'formatting never changes its model');
});

test('Dashboard renders the flow, the release, the strip, agents, the four lists and lanes from plain input [N26]', () => {
  const input = dashboardData({ populated: true });
  const { clockBase } = input;
  const quietModel = dashboardModel(input.project, input.events, { now: clockBase + 21 * 60_000, complete: true });
  assert.equal(quietModel.agents.find(agent => agent.id === 'quiet-1')?.group, 'between items', '19 minutes since activity is not quiet');
  assert.equal(quietModel.agents.find(agent => agent.id === 'quiet-2')?.group, 'quiet', '21 minutes since activity folds the agent into Quiet');
  const quietAgents = section(dashboardHtml(quietModel), 'Agents');
  assert.match(quietAgents, /▸ <b>1<\/b>&nbsp;idle · up to \d+m/u, 'between-items agents sit behind one line');
  assert.match(quietAgents, /data-dashboard-agent="quiet-1"/u);
  assert.doesNotMatch(quietAgents, /data-dashboard-agent="quiet-2"/u, 'an agent quiet for 20 minutes is not at work and stays off the table');
  const expiredWindow = dashboardModel(input.project, input.events, { now: clockBase + 5 * 60 * 60_000, complete: true });
  assert.ok(!expiredWindow.agents.some(agent => agent.id === 'quiet-2'), 'a seeded seat with no activity in the four-hour window is excluded, rather than counted quiet');

  const now = clockBase + 61 * 60_000;
  const model = dashboardModel(input.project, input.events, { now, complete: true });
  const html = dashboardHtml(model);
  const flow = section(html, 'How work moved');
  assert.match(flow, /<b>11<\/b> claimed → <b>10<\/b> submitted<\/span><span class="dash-stage-b">0 handed back · median 3m/u, 'claims and submits from the folded events');
  assert.match(flow, /<b>4<\/b> accepted · <b>0<\/b> sent back/u);
  assert.match(flow, /<b>3<\/b> landed · <b>1<\/b> to land/u);
  const shipping = section(html, 'Release');
  const summary = model.milestone.summary;
  assert.match(shipping, new RegExp(`>${summary.left} to go</button></b><span>${summary.landed} of ${summary.total} landed</span>`, 'u'));
  assert.match(shipping, new RegExp(`data-release-segment="landed" data-count="${summary.landed}"`, 'u'));
  assert.match(shipping, /In review<button type="button" class="dash-n dash-faint" data-dashboard-list="review">6<\/button>/u);
  assert.match(shipping, /<summary>Show 2 more<\/summary>/u, 'the in-flight review column expands beyond four rows');

  const strip = section(html, 'Pace and agent time');
  assert.equal([...strip.matchAll(/<rect class="(?:now)?" x=/gu)].length, 24, 'the spark draws each hourly bin');
  assert.match(strip, /in the last 24 hours · peak <b>3\/h<\/b>/u, 'the strip reads the seeded landing bins');
  assert.match(strip, /building <b>\d+%<\/b> · reviewing <b>\d+%<\/b> · idle <b>\d+%<\/b>/u, 'agent time reports all three shares');

  assert.match(section(html, 'Landing'), /data-go="item:4"[\s\S]*passed \d+m/u, 'the accepted item shows how long ago it passed');
  const review = section(html, 'In review');
  assert.match(review, /1 being reviewed · 0 pending review/u);
  assert.equal([...section(html, 'In the gate').matchAll(/class="dash-row"/gu)].length, 5, 'the submitted items no reviewer holds are in the gate');
  assert.equal([...section(html, 'Landed · 4 h').matchAll(/class="dash-row"/gu)].length, 3);
  assert.match(section(html, 'Landed · 4 h'), /All 3 ›/u);

  const agents = section(html, 'Agents');
  assert.match(agents, /<th>Now<\/th><th class="r hide">Build<\/th><th class="r hide">Review<\/th><th class="r hide">Idle<\/th><th class="r hide">Shouts<\/th>/u, 'separate columns share the timeline header');
  assert.match(agents, /Building · <button[^>]*>1<\/button>/u, 'group rows carry the real group count');
  assert.ok(!model.agents.some(agent => agent.id === 'sentinel'), 'the sentinel is a service, not an agent row');
  const builderRow = agents.match(/<tr data-dashboard-agent="web-1">[\s\S]*?<\/tr>/u)?.[0];
  assert.ok(builderRow);
  assert.match(builderRow, /<td class="who" title="web-1[^"]*"><i class="dash-st b"><\/i>web-1<\/td>/u, 'the mono name holds only the seat name, with the model in the tooltip');
  assert.equal([...builderRow.matchAll(/class="dash-num/gu)].length, 4, 'build, review, idle and shouts occupy separate columns');
  assert.match(agents, /aria-label="web-1 last four hours"/u);
  assert.match(agents, /aria-label="tests-1 last four hours"/u);
  const buildSegment = model.agents.find(agent => agent.id === 'web-1')?.segments.find(segment => segment.item === 21);
  assert.ok(buildSegment, 'the active build has a timeline segment');
  assert.match(agents, new RegExp(`#21 building · ${Math.round((buildSegment.end - buildSegment.start) / 60_000)}m`, 'u'));
  assert.match(section(html, 'Your lanes'), /<td class="ln">web<\/td>/u);
});

test('Dashboard draws no hero, Rulings card, comparison or Pipeline section, and prints no raw milliseconds [N26]', () => {
  const input = dashboardData({ populated: true });
  const model = dashboardModel(input.project, input.events, { now: input.clockBase, complete: true });
  model.comparison = { version: 1, available: false, reason: 'not drawn here' };
  model.pipeline = { count: 1, limit: 20, items: [], totals: {}, causes: {}, unmeasuredGaps: [], evidence: 'raw' };
  const html = dashboardHtml(model, { needs: '<li class="needs-call">row</li>', rules: '<p>rules</p>', capacity: '<p>capacity</p>' });
  assert.doesNotMatch(html, /dash-hero|aria-label="Rulings"|window-comparison|The last two hours|aria-label="Pipeline"|data-pipeline|needs-call|<p>rules<\/p>|<p>capacity<\/p>/u,
    'the approved Dashboard leaves out the old hero, Rulings, the comparison (Activity), the Pipeline detail and the retired Home cards');
  assert.ok(!/\d\s?ms\b|milliseconds/u.test(html), 'no duration is printed in raw milliseconds');
});

test('Dashboard strip counts a verified item in a live landing batch as Landing, like Items Pipeline [N38]', () => {
  const input = dashboardData({ populated: true });
  const open = input.project.items.find(item => item.status === 'open');
  const verified = { ...open, status: 'verified', merged: false };
  const items = [verified, ...input.project.items.filter(item => item.id !== open.id)];
  const before = dashboardModel({ ...input.project, items, landingBatches: [] }, input.events, { now: input.clockBase, complete: true }).stageCounts;
  const batch = { id: 'live', state: 'running', startedAt: input.clockBase - 60_000, items: [{ id: verified.id }] };
  const after = dashboardModel({ ...input.project, items, landingBatches: [batch] }, input.events, { now: input.clockBase, complete: true }).stageCounts;
  assert.equal(after.landing, before.landing + 1, 'the batched item counts as Landing');
  assert.equal(after.verified, before.verified - 1, 'and no longer as Verified');
  assert.equal(Object.values(after).reduce((sum, count) => sum + count, 0), Object.values(before).reduce((sum, count) => sum + count, 0), 'no item is lost or counted twice');
});
