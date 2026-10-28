/** Pure populated Dashboard HTML from deterministic data; native wiring remains in the audit journey [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../src/view/dashboard-render.js';
import { dashboardModel } from '../../src/view/dashboard-model.js';
import { roadmapSummary } from '../../src/view/roadmap-summary.js';
import { dashboardData } from './view-data.js';

/** Extract a single named Dashboard section so row and footer assertions stay scoped. */
function section(html, name) {
  const start = html.indexOf(`aria-label="${name}"`);
  assert.notEqual(start, -1, `Dashboard renders ${name}`);
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, `${name} section closes`);
  return html.slice(start, end);
}

/** Count actual item rows rendered in a card, excluding links and headings. */
function itemRows(html) { return [...html.matchAll(/class="dash-item"/gu)].length; }

test('Dashboard time and number labels depend on supplied locale and zone, not the test host [N26,C7]', () => {
  const input = dashboardData({ populated: true });
  const model = dashboardModel(input.project, input.events, { now: input.clockBase, complete: true });
  model.totals.allTime = 1234;
  const before = JSON.stringify(model);
  const utc = dashboardHtml(model, { locale: 'en-GB', timeZone: 'UTC' });
  const tokyo = dashboardHtml(model, { locale: 'en-GB', timeZone: 'Asia/Tokyo' });
  assert.match(section(utc, 'Shipping now'), /Wednesday at 14:00 – Wednesday at 16:00/u);
  assert.match(section(tokyo, 'Shipping now'), /Wednesday at 23:00 – Thursday at 01:00/u);
  assert.match(section(utc, 'Landed per hour'), /28\/10\/2026, 11:00:00 – 12:00:00/u);
  assert.match(section(tokyo, 'Landed per hour'), /28\/10\/2026, 20:00:00 – 21:00:00/u);
  assert.match(utc, /1,234 landed all time/u);
  assert.match(dashboardHtml(model, { locale: 'de-DE', timeZone: 'UTC' }), /1\.234 landed all time/u);
  assert.equal(dashboardHtml(model), dashboardHtml(model, { locale: 'en-US', timeZone: 'UTC' }), 'omitted preferences have deterministic defaults');
  assert.equal(dashboardHtml(model, { locale: 'en-GB', timeZone: 'UTC' }), utc);
  assert.equal(JSON.stringify(model), before, 'formatting never changes its model');
});

test('Dashboard renders release, charts, agents, landings and capped lists from plain input [N26]', () => {
  const input = dashboardData({ populated: true });
  const { clockBase } = input;
    const quietModel = dashboardModel(input.project, input.events, { now: clockBase + 21 * 60_000, complete: true });
    assert.equal(quietModel.agents.find(agent => agent.id === 'quiet-1')?.group, 'between items', '19 minutes since activity is not quiet');
    assert.equal(quietModel.agents.find(agent => agent.id === 'quiet-2')?.group, 'quiet', '21 minutes since activity folds the agent into Quiet');
    const quietHtml = dashboardHtml(quietModel);
    const expiredWindow = dashboardModel(input.project, input.events, { now: clockBase + 5 * 60 * 60_000, complete: true });
    assert.ok(!expiredWindow.agents.some(agent => agent.id === 'quiet-2'), 'a seeded seat with no activity in the four-hour window is excluded, rather than counted quiet');
    assert.match(section(quietHtml, 'Agents'), /1 quiet agents · nothing in the last 20 minutes/u);
    assert.match(section(quietHtml, 'Agents'), /quiet-1/u);
    assert.match(section(quietHtml, 'Agents'), /quiet-2/u);

    const now = clockBase + 61 * 60_000;
    const model = dashboardModel(input.project, input.events, { now, complete: true });
    const progress = model.milestone ? roadmapSummary(model.milestone)?.detail ?? '' : '';
    const html = dashboardHtml(model, { progress });
    const shipping = section(html, 'Shipping now');
    const summary = model.milestone.summary;
    assert.match(shipping, new RegExp(`${summary.left} to go`, 'u'));
    assert.match(shipping, new RegExp(`${summary.landed} of ${summary.total} landed`, 'u'));
    assert.match(shipping, new RegExp(`data-summary-segment="landed" data-count="${summary.landed}"`, 'u'));
    assert.match(shipping, new RegExp(`${(model.pace.last2h / 2).toFixed(1)} <small>items an hour</small>`, 'u'));
    assert.match(shipping, new RegExp(`${(model.pace.last6h / 6).toFixed(1)} <small>items an hour</small>`, 'u'));
    assert.match(shipping, new RegExp(`${summary.estimate.low === summary.estimate.high
      ? `${summary.estimate.low} h` : `${summary.estimate.low}–${summary.estimate.high} h`}`, 'u'));
    assert.match(shipping, /\d{1,2}:\d{2}/u, 'the shared estimate includes a weekday time');
    assert.match(shipping, /In review 6/u);
    assert.match(shipping, /<summary>Show 2 more<\/summary>/u, 'the in-flight review column expands beyond four rows');

    const chart = section(html, 'Landed per hour');
    assert.equal([...chart.matchAll(/<rect\b/gu)].length, 24, 'the chart renders each hourly bin');
    assert.equal([...chart.matchAll(/<title>/gu)].length, 25, 'each hour and the six-hour pace line expose a tooltip');
    assert.match(chart, /class="dash-pace-line"[\s\S]*?<title>0\.5 items an hour over the last 6 hours<\/title>/u);

    const landing = section(html, 'Landing now');
    assert.match(landing, /Accepted, waiting to land/u);
    assert.match(landing, /web-1/u);
    const acceptedAt = Date.parse(input.events.findLast(event => event.event_kind === 'accept' && event.item_id === 4).event_at);
    const acceptedBy = input.events.findLast(event => event.event_kind === 'accept' && event.item_id === 4).event_by;
    const ageMinutes = Math.floor((now - acceptedAt) / 60_000);
    const acceptedAge = ageMinutes < 60 ? `${ageMinutes}m` : `${(ageMinutes / 60).toFixed(1)}h`;
    assert.ok(landing.includes(acceptedBy), 'the accepted item names the actual verifier from board history');
    assert.ok(landing.includes(`passed ${acceptedAge} ago`), 'the accepted item shows its actual elapsed time');

    const inReview = section(html, 'In review');
    assert.equal(itemRows(inReview), 6);
    assert.match(inReview, /class="dash-old"/u, 'reviews over an hour old receive the overdue treatment');
    assert.match(inReview, /All in review, oldest first/u);
    const nextUp = section(html, 'Next up');
    assert.equal(itemRows(nextUp), 8, 'the ready list is capped at eight rows');
    assert.match(nextUp, /All ready, in rank order/u);
    const justLanded = section(html, 'Just landed');
    assert.equal(itemRows(justLanded), 3);
    assert.match(justLanded, /All landed in Activity/u);

    const agents = section(html, 'Agents');
    assert.match(agents, /<span>Now<\/span><span>Build<\/span><span>Review<\/span><span>Shouts<\/span>/u, 'separate columns share the timeline header');
    assert.match(agents, /BUILDING · 1/u, 'uppercase mono group labels include the real group count');
    assert.match(agents, /data-dashboard-icon="build"/u);
    assert.match(agents, /data-dashboard-icon="review"/u);
    assert.match(agents, /data-dashboard-icon="back"/u, 'the sent-back legend retains its distinct symbol');
    assert.ok(!model.agents.some(agent => agent.id === 'sentinel'), 'the sentinel is a service, not an agent row');
    const builderRow = agents.match(/data-dashboard-agent="web-1"[\s\S]*?<\/div>/u)?.[0];
    assert.ok(builderRow);
    assert.match(builderRow, /<b title="web-1[^"]*">[\s\S]*?<\/svg>web-1<\/b>/u, 'the mono name contains only the actual seat name, with the model held in the tooltip');
    assert.equal([...builderRow.matchAll(/class="dash-agent-number"/gu)].length, 3, 'build, review and shouts occupy separate columns');
    for (const symbol of ['clock', 'land', 'pass', 'back', 'msg']) assert.match(html, new RegExp('data-dashboard-icon="'+symbol+'"', 'u'), 'headline icon '+symbol);
    assert.match(chart, /3 in 24 h · busiest hour 3/u, 'the chart caption uses the seeded landing bins');
    assert.match(chart, /class="dash-pace-tag"/u, 'today pace is labeled on the line');
    assert.equal([...chart.matchAll(/<span>/gu)].length, 5, 'the chart has four six-hour labels and now');

    assert.match(agents, /aria-label="web-1 last four hours"/u);
    assert.match(agents, /aria-label="tests-1 last four hours"/u);
    const buildSegment = model.agents.find(agent => agent.id === 'web-1')?.segments.find(segment => segment.item === 21);
    assert.ok(buildSegment, 'the active build has a timeline segment');
    assert.match(agents, new RegExp(`#21 building · ${Math.round((buildSegment.end - buildSegment.start) / 60_000)}m`, 'u'));
    assert.match(section(html, 'Agent time'), /Building[\s\S]*Reviewing[\s\S]*Between items/u, 'agent time reports all three categories');
});
