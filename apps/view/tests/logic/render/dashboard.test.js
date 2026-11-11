/** Pure populated Dashboard HTML from deterministic data; native wiring remains in the audit journey [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { roadmapSummary } from '../../../src/logic/summary/roadmap.js';
import { dashboardData } from '../../fixtures/cockpit/data.js';
import { compareFlowWindows } from '../../../../../packages/stats/browser.js';

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
  const utcProgress = roadmapSummary(model.milestone, { now: model.now, locale: 'en-GB', timeZone: 'UTC' })?.header ?? '';
  const tokyoProgress = roadmapSummary(model.milestone, { now: model.now, locale: 'en-GB', timeZone: 'Asia/Tokyo' })?.header ?? '';
  const utc = dashboardHtml(model, { locale: 'en-GB', timeZone: 'UTC', progress: utcProgress });
  const tokyo = dashboardHtml(model, { locale: 'en-GB', timeZone: 'Asia/Tokyo', progress: tokyoProgress });
  assert.match(section(utc, 'Shipping now'), /done in about 3 hours, Wednesday afternoon/u);
  assert.match(section(tokyo, 'Shipping now'), /done in about 3 hours, Thursday overnight/u);
  assert.match(section(utc, 'Landed per hour'), /28\/10\/2026, 11:00:00 – 12:00:00/u);
  assert.match(section(tokyo, 'Landed per hour'), /28\/10\/2026, 20:00:00 – 21:00:00/u);
  assert.match(utc, /1,234 landed all time/u);
  assert.match(dashboardHtml(model, { locale: 'de-DE', timeZone: 'UTC' }), /1\.234 landed all time/u);
  assert.equal(dashboardHtml(model), dashboardHtml(model, { locale: 'en-US', timeZone: 'UTC' }), 'omitted preferences have deterministic defaults');
  assert.equal(dashboardHtml(model, { locale: 'en-GB', timeZone: 'UTC', progress: utcProgress }), utc);
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
    const progress = model.milestone ? roadmapSummary(model.milestone, { now: model.now, locale: 'en-US', timeZone: 'UTC' })?.header ?? '' : '';
    const html = dashboardHtml(model, { progress });
    const shipping = section(html, 'Shipping now');
    const summary = model.milestone.summary;
    assert.match(shipping, new RegExp(`${summary.left} to go`, 'u'));
    assert.match(shipping, new RegExp(`${summary.landed} of ${summary.total} landed`, 'u'));
    assert.match(shipping, new RegExp(`data-summary-segment="landed" data-count="${summary.landed}"`, 'u'));
    assert.match(shipping, new RegExp(`${(model.pace.last6h / 6).toFixed(1)} items an hour`, 'u'));
    assert.match(shipping, new RegExp(`${model.pace.last6h} landed in the last 6 h, ${model.pace.last2h} in the last 2 h`, 'u'));
    assert.match(shipping, /done in about 3 hours, Wednesday afternoon/u, 'the shared estimate includes a weekday part of day');
    assert.doesNotMatch(shipping, /dash-stats|Right now|Done at this pace/u, 'the old pace boxes are removed');
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


test('Dashboard consumes labelled API comparison scalars without rebuilding their history [N26,R1,R2]', () => {
  const input = dashboardData({ populated: true });
  const current = { since:'2026-10-28T10:00:00.000Z', until:'2026-10-28T12:00:00.000Z', landed:2, agentHours:4, agentHoursPerLanding:2, idleShare:0.5, submitsPerItem:1.5, rejectRate:0.25, shoutsPerLanding:1,
    idleReasons:{'nothing-eligible':0.1,held:0.1,'review-family':0.1,'main-red':0.1,unknown:0.1}, stageShares:{build:0.2,rework:0.2,reviewWait:0.2,review:0.2,land:0.2} };
  const previous = { ...structuredClone(current), since:'2026-10-28T08:00:00.000Z', until:'2026-10-28T10:00:00.000Z', landed:1, agentHoursPerLanding:4, idleShare:null };
  const change = { landed:1,agentHours:0,agentHoursPerLanding:-2,idleShare:null,submitsPerItem:0,rejectRate:0,shoutsPerLanding:0,
    idleReasons:{'nothing-eligible':0,held:0,'review-family':0,'main-red':0,unknown:0},stageShares:{build:0,rework:0,reviewWait:0,review:0,land:0} };
  input.project.statsComparison = { version:1,available:true,durationMinutes:120,current,previous,change };
  const before = JSON.stringify(input.project.statsComparison);
  const model = dashboardModel(input.project, [], { now:input.clockBase,complete:false });
  assert.strictEqual(model.comparison,input.project.statsComparison,'API comparison remains authoritative even while browser history is loading');
  const html = section(dashboardHtml(model),'Window comparison');
  assert.match(html,/data-stats-as-of="2026-10-28T12:00:00.000Z"/u);
  assert.ok(html.includes(new Date(current.until).toLocaleTimeString('en-US', { timeZone:'UTC', hour:'numeric', minute:'2-digit' })), 'canonical observation time uses the supplied display zone');
  assert.match(html,/120-minute windows/u);
  assert.equal([...html.matchAll(/data-stats-comparison=/gu)].length,17);
  assert.match(html,/data-stats-comparison="landed" data-current="2" data-previous="1" data-change="1"/u);
  assert.match(html,/data-stats-comparison="agentHoursPerLanding" data-current="2" data-previous="4" data-change="-2"/u);
  assert.match(html,/unmeasured/u);
  assert.match(html,/percentage points/u);
  assert.match(html,/all observed seat-hours as their denominator/u);
  assert.match(html,/data-stats-comparison="idleShare" data-current="0.5" data-previous="null" data-change="null"/u);
  assert.equal(JSON.stringify(input.project.statsComparison),before,'rendering never alters metric evidence');
});


test('Dashboard preserves unavailable comparison reasons and never turns missing evidence into zero [N26]', () => {
  const input = dashboardData({ populated: true });
  input.project.statsComparison = { version:1, available:false, reason:'No recorded seat intervals <yet>' };
  const html = section(dashboardHtml(dashboardModel(input.project, input.events, { now:input.clockBase, complete:true })), 'Window comparison');
  assert.match(html,/No recorded seat intervals &lt;yet&gt;/u);
  assert.doesNotMatch(html,/data-stats-comparison=/u);
  delete input.project.statsComparison;
  assert.doesNotMatch(dashboardHtml(dashboardModel(input.project,input.events,{ now:input.clockBase,complete:true })),/aria-label="Window comparison"/u);
});


test('seeded event windows reach Dashboard rows through the canonical comparison projection [N26,R1,R2]', () => {
  const input = dashboardData({ populated: true });
  const base = input.clockBase - 240 * 60_000;
  /** Fix every event at an exact minute so no host clock supplies a measurement. */
  function at(minutes) { return new Date(base + minutes * 60_000).toISOString(); }
  const rows = [
    [0,'core-1','join',null,{lane:'core'}], [0,'review-1','join',null,{lane:'review'}],
    [0,'coordinator','add',1,{lane:'core'}], [10,'core-1','claim',1,{leaseUntil:at(300)}],
    [20,'core-1','submit',1,{commit:'a'.repeat(40)}], [30,'review-1','reserve',1,{until:at(300)}],
    [40,'review-1','accept',1,{commit:'a'.repeat(40)}], [60,'coordinator','merged',1,{}],
    [80,'core-1','shout',null,{to:'coordinator'}], [130,'coordinator','add',2,{lane:'core'}],
    [135,'core-1','claim',2,{leaseUntil:at(300)}], [140,'core-1','shout',null,{to:'coordinator'}],
    [150,'core-1','submit',2,{commit:'b'.repeat(40)}], [160,'core-1','shout',null,{to:'coordinator'}],
    [165,'review-1','reserve',2,{until:at(300)}], [175,'review-1','accept',2,{commit:'b'.repeat(40)}],
    [180,'coordinator','merged',2,{}],
  ];
  // Plain event inputs exercise the shared projection, not a fabricated operational board or proof receipt.
  const history = rows.map(([minute,by,kind,id,detail],index) => ({ event_id:index+1,event_at:at(minute),event_by:by,event_kind:kind,item_id:id,event_detail:JSON.stringify(detail) }));
  const original = JSON.stringify(history);
  const comparison = compareFlowWindows(history, { now:input.clockBase,windowMinutes:120,complete:true });
  assert.equal(comparison.current.landed,1);
  assert.equal(comparison.previous.landed,1);
  assert.equal(comparison.current.agentHours,4,'two observed seats span the two-hour window');
  assert.equal(comparison.current.agentHoursPerLanding,4);
  assert.equal(comparison.current.shoutsPerLanding,2);
  assert.equal(comparison.previous.shoutsPerLanding,1);
  assert.equal(comparison.change.shoutsPerLanding,1);
  assert.equal(comparison.current.idleReasons.unknown,comparison.current.idleShare,'unrecorded historical reasons remain unknown');
  input.project.statsComparison = comparison;
  const html = section(dashboardHtml(dashboardModel(input.project,history,{now:input.clockBase,complete:true})),'Window comparison');
  const metrics = [
    ...['landed','agentHours','agentHoursPerLanding','idleShare','submitsPerItem','rejectRate','shoutsPerLanding'].map(key => [key,null]),
    ...['nothing-eligible','held','review-family','main-red','unknown'].map(key => [key,'idleReasons']),
    ...['build','rework','reviewWait','review','land'].map(key => [key,'stageShares']),
  ];
  for (const [key,group] of metrics) {
    const name = group ? group+'.'+key : key;
    const values = ['current','previous','change'].map(period => JSON.stringify(group ? comparison[period][group][key] : comparison[period][key]));
    assert.ok(html.includes('data-stats-comparison="'+name+'" data-current="'+values[0]+'" data-previous="'+values[1]+'" data-change="'+values[2]+'"'),name+' preserves its canonical values');
  }
  assert.equal(JSON.stringify(history),original,'the pure renderer does not change recorded inputs');
});

test('Dashboard has no Pipeline section and prints no raw milliseconds; The last two hours stays [N26]', () => {
  const input = dashboardData({ populated: true });
  const model = dashboardModel(input.project, input.events, { now: input.clockBase, complete: true });
  const current = { since:'2026-10-28T10:00:00.000Z', until:'2026-10-28T12:00:00.000Z', landed:2, agentHours:4, agentHoursPerLanding:2, idleShare:0.5, submitsPerItem:1.5, rejectRate:0.25, shoutsPerLanding:1,
    idleReasons:{'nothing-eligible':0.1,held:0.1,'review-family':0.1,'main-red':0.1,unknown:0.1}, stageShares:{build:0.2,rework:0.2,reviewWait:0.2,review:0.2,land:0.2} };
  model.comparison = { version:1, available:true, durationMinutes:120, current, previous:{ ...structuredClone(current), landed:1 },
    change:{ landed:1,agentHours:0,agentHoursPerLanding:0,idleShare:null,submitsPerItem:0,rejectRate:0,shoutsPerLanding:0,
      idleReasons:{'nothing-eligible':0,held:0,'review-family':0,'main-red':0,unknown:0},stageShares:{build:0,rework:0,reviewWait:0,review:0,land:0} } };
  model.pipeline = { count: 1, limit: 20, items: [], totals: {}, causes: {}, unmeasuredGaps: [], evidence: 'raw' };
  const html = dashboardHtml(model);
  // The compact stage strip (N38) is the one Pipeline element; the API's pipeline detail still never renders.
  assert.ok(!/dash-pipeline|data-pipeline/u.test(html), 'no Pipeline detail section, even when the API supplies the data');
  assert.equal([...html.matchAll(/aria-label="Pipeline"/gu)].length, 1, 'the compact stage strip is the only Pipeline section');
  assert.ok(!/\d\s?ms\b|milliseconds/u.test(html), 'no duration is printed in raw milliseconds');
  assert.match(html, /<h2>The last two hours<\/h2>/u, 'the approved window card remains');
});

test('Dashboard shows a compact pipeline strip of seven stages that link to Items > Pipeline [N38]', () => {
  const input = dashboardData({ populated: true });
  const model = dashboardModel(input.project, input.events, { now: input.clockBase, complete: true });
  const html = dashboardHtml(model);
  const strip = section(html, 'Pipeline');
  const keys = ['gated', 'ready', 'building', 'in-review', 'verified', 'landing', 'merged'];
  assert.deepEqual([...strip.matchAll(/data-dashboard-stage="([^"]+)"/gu)].map(match => match[1]), keys, 'all seven stages show, in pipeline order');
  assert.equal([...strip.matchAll(/href="#items\/pipeline"/gu)].length, 7, 'each stage links to Items > Pipeline');
  for (const key of keys) assert.match(strip, new RegExp(`data-dashboard-stage="${key}"><span>[^<]+</span> <b>\\d+</b>`, 'u'), `${key} shows a count`);
  assert.equal(itemRows(strip), 0, 'the strip lists no item rows');
  assert.doesNotMatch(strip, /\d\s?ms\b/u, 'the strip shows no millisecond durations');
  const empty = dashboardHtml({ ...model, stageCounts: Object.fromEntries(keys.map(key => [key, 0])) });
  assert.equal([...section(empty, 'Pipeline').matchAll(/<b>0<\/b>/gu)].length, 7, 'a stage with no items still shows 0');
});
