/** Pure agent-floor model/HTML checks over plain deterministic input; no browser or native setup [N26,N38]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentFloorHtml } from '../../../../src/logic/agent/floor/render.js';
import { agentFloorModel } from '../../../../src/logic/agent/floor/model.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { agentFloorData } from '../../../fixtures/cockpit/floor.js';

const MINUTE = 60_000;
const seeded = agentFloorData();

/** Project the Dashboard, then the floor from it, at one moment, as the page does. */
function floorAt(now) {
  const model = dashboardModel(seeded.input.project, seeded.input.events, { now, complete: true });
  const floor = agentFloorModel(model, seeded.input.events);
  return { model, floor, html: agentFloorHtml(floor, { back: '/dashboard' }) };
}

/** One named section of the floor, so each case reads only its own markup. */
function section(html, name) {
  const start = html.indexOf(`aria-label="${name}"`);
  assert.notEqual(start, -1, `the floor renders ${name}`);
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, `${name} closes`);
  return html.slice(start, end);
}

/** The age the floor prints for a span of time. */
function age(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  return minutes < 60 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
}

test('Agent Floor labels use explicit locale and timezone with stable pure-render defaults [N26,C7]', () => {
  const { floor } = floorAt(seeded.now);
  floor.now = Date.parse('2026-10-28T12:00:00Z');
  floor.numbers.allTime = 1234;
  const before = JSON.stringify(floor);
  const utc = agentFloorHtml(floor, { locale: 'en-GB', timeZone: 'UTC' });
  const tokyo = agentFloorHtml(floor, { locale: 'en-GB', timeZone: 'Asia/Tokyo' });
  assert.match(utc, /data-floor-clock datetime="2026-10-28T12:00:00\.000Z">12:00:00<\/time>/u);
  assert.match(tokyo, /data-floor-clock datetime="2026-10-28T12:00:00\.000Z">21:00:00<\/time>/u);
  assert.match(utc, /1,234 items landed all time/u);
  assert.match(agentFloorHtml(floor, { locale: 'de-DE', timeZone: 'UTC' }), /1\.234 items landed all time/u);
  assert.equal(agentFloorHtml(floor), agentFloorHtml(floor, { locale: 'en-US', timeZone: 'UTC' }));
  assert.equal(agentFloorHtml(floor, { locale: 'en-GB', timeZone: 'UTC' }), utc);
  assert.equal(JSON.stringify(floor), before);
});

test('the floor\'s headline counts live agents, builders, reviewers and 24-hour landings from the board [N26]', () => {
  const { model, floor, html } = floorAt(seeded.now);
  const headline = section(html, 'Headline');
  assert.match(headline, /<h1><em>2 landed in 24 hours\.<\/em> 2 peak agents\.<\/h1>/u);
  assert.equal(floor.numbers.peak, model.peak, 'the floor and the Dashboard count the same peak');
  assert.equal(floor.numbers.landed, model.totals.day, 'the floor and the Dashboard count the same landings');
  assert.equal(floor.numbers.building, model.claims.length, 'the floor and the Dashboard count the same builders');
});

test('the floor\'s full row of numbers names every count the person asked for [N26]', () => {
  const { floor, html } = floorAt(seeded.now);
  const band = section(html, 'Board numbers');
  const expected = { live: 3, building: 1, reviewing: 1, between: 1, landed: 2, accepted: 3, 'sent-back': 1, shouts: 1, 'in-review': 2, waiting: 1, ready: 3 };
  const labels = ['Live', 'Building', 'Reviewing', 'Between', 'Landed', 'Passed', 'Sent back', 'Shouts', 'In review', 'To land', 'Ready'];
  const shown = [...band.matchAll(/data-floor-stat="([^"]+)" data-value="([^"]*)"><b>[^<]*<\/b><span>([^<]*)<\/span>/gu)].map(match => [match[1], match[2], match[3]]);
  assert.deepEqual(shown.map(([key]) => key), Object.keys(expected), 'eleven numbers, in the person\'s order');
  assert.deepEqual(shown.map(([, , label]) => label), labels);
  for (const [key, value] of shown) assert.equal(value, String(expected[key]), `${key} reads the seeded board`);
  assert.match(band, /4 seen in 4 h/u, 'every seat seen in the window, quiet ones included');
  assert.match(band, /1 pending review/u);
  assert.equal(floor.numbers.unreviewed, 1);
});

test('landed per hour draws 24 hourly bars with the day\'s total, peak and average [N26]', () => {
  const { model, html } = floorAt(seeded.now);
  const chart = section(html, 'Landed per hour');
  assert.equal([...chart.matchAll(/<rect\b/gu)].length, 24, 'one bar per hour');
  const peak = Math.max(...model.bins.map(bin => bin.count));
  assert.match(chart, new RegExp(`2 in 24 h · peak ${peak}/h · 0\\.1/h average`, 'u'));
  assert.equal([...chart.matchAll(/<title>(\d+) landed,/gu)].reduce((sum, match) => sum + Number(match[1]), 0), 2, 'the bars hold both landings');
});

test('agent time splits the window into building, reviewing and holding nothing [N26]', () => {
  const { floor, html } = floorAt(seeded.now);
  const time = section(html, 'Agent time');
  for (const label of ['Building', 'Reviewing', 'Holding nothing']) assert.match(time, new RegExp(`${label} <b>\\d+%</b>`, 'u'));
  const total = floor.time.build + floor.time.review + floor.time.idle;
  const widths = [...time.matchAll(/<rect class="(build|review|idle)" x="[^"]+" width="([^"]+)"/gu)].map(match => Number(match[2]));
  assert.equal(widths.length, 3);
  assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 1000) < 1, 'the three parts fill the bar');
  assert.ok(floor.time.build > 0 && floor.time.review > 0 && total > floor.time.build + floor.time.review, 'all three kinds of time are present');
});

test('every agent has a four-hour line with what it holds, its times and shouts, quiet agents unfolded [N26]', () => {
  const { floor, html } = floorAt(seeded.now);
  const agents = section(html, 'Agents');
  assert.doesNotMatch(agents, /<details/u, 'no agent is folded away');
  for (const [group, count] of [['Building', 1], ['Reviewing', 1], ['Idle', 1], ['Quiet for 20 min or more', 1]]) {
    assert.match(agents, new RegExp(`<h3 class="floor-group">${group} · ${count}</h3>`, 'u'));
  }
  const line = id => agents.match(new RegExp(`data-floor-agent="${id}"[\\s\\S]*?</span></div>`, 'u'))?.[0] ?? '';
  const builder = line('web-1'), reviewer = line('tests-1'), between = line('quiet-1'), quiet = line('quiet-2');
  assert.ok(builder && reviewer && between && quiet, 'all four seats have a line');
  const held = floor.groups[0].agents[0].holding[0];
  assert.equal(held.item.id, seeded.held.id);
  /** When the board wrote this seat's latest move of a kind on an item. */
  const moved = (kind, id, by) => Date.parse(seeded.input.events.findLast(event => event.event_kind === kind && event.item_id === id && event.event_by === by).event_at);
  assert.equal(held.since, moved('claim', seeded.held.id, 'web-1'), 'the hold counts from the board\'s claim');
  assert.match(builder, new RegExp(`#${seeded.held.id} building ${age(seeded.now - moved('claim', seeded.held.id, 'web-1'))}</span>`, 'u'), 'the builder shows its item and how long it has held it');
  assert.ok(builder.includes(`<b>${seeded.held.title}</b>`), 'and that item\'s title');
  assert.match(builder, /<rect class="build" /u, 'its building time is drawn');
  assert.match(builder, /class="floor-landed"/u, 'landings in the window are marked');
  assert.match(reviewer, new RegExp(`#4 reviewing ${age(seeded.now - moved('reserve', 4, 'tests-1'))}</span>`, 'u'), 'the review counts from its reservation');
  assert.match(reviewer, /<rect class="review" /u);
  assert.match(reviewer, /class="floor-back"[^>]*><title>#6 sent back<\/title>/u, 'the sent-back mark sits on the reviewer who sent it');
  assert.match(between, /class="floor-shout"/u, 'a shout is marked on the line');
  assert.match(between, /holding nothing/u);
  assert.match(quiet, /holding nothing/u);
  for (const entry of [builder, reviewer, between, quiet]) {
    assert.deepEqual([...entry.matchAll(/data-label="([^"]+)"/gu)].map(match => match[1]), ['Build', 'Review', 'Idle', 'Shouts']);
  }
  assert.match(between, /data-label="Shouts">1</u);
  assert.match(agents, /<span>Agent<\/span><span>[^<]+ → now<\/span><span>Now<\/span><span>Build<\/span><span>Review<\/span><span>Idle<\/span><span>Shouts<\/span>/u);
});

test('the four queues list every item in full, each with its age [N26]', () => {
  const { html } = floorAt(seeded.now);
  const events = seeded.input.events;
  /** When the latest event of a kind happened to an item. */
  const at = (kind, id) => Date.parse(events.findLast(event => event.event_kind === kind && event.item_id === id).event_at);
  const cases = [
    ['In review', [[4, at('submit', 4)], [5, at('submit', 5)]]],
    ['Accepted, waiting to land', [[3, at('accept', 3)]]],
    ['Ready, nobody building', [[6, at('reject', 6)], [8, at('add', 8)], [9, at('add', 9)]]],
    ['Landed · 24 h', [[2, at('merged', 2)], [1, at('merged', 1)]]],
  ];
  for (const [name, rows] of cases) {
    const queue = section(html, name);
    const shown = [...queue.matchAll(/data-go="item:(\d+)"[\s\S]*?data-floor-age>([^<]+)</gu)].map(match => [Number(match[1]), match[2]]);
    assert.deepEqual(shown, rows.map(([id, when]) => [id, age(seeded.now - when)]), `${name} lists each item with its age`);
    assert.match(queue, new RegExp(`<b>${shown.length}</b></h2>`, 'u'), `${name} counts its rows`);
  }
});

/**
 * Render the floor for a hand-built board through the production path, so each age case sets its own clock.
 * `moves` are [kind, by, item, minutes before now, detail] in board order.
 */
function floorFor(items, moves, now = Date.parse('2026-10-28T12:00:00Z')) {
  const events = moves.map(([kind, by, item, ago, detail = {}], index) => ({ event_id: index + 1, event_kind: kind, event_by: by,
    item_id: item, event_at: new Date(now - ago * MINUTE).toISOString(), event_detail: JSON.stringify(detail) }));
  const project = { items: items.map(([id, status, by, untilAgo]) => ({ id, title: `Item ${id}`, lane: 'web', status,
    claim: by ? { by, until: new Date(now - untilAgo * MINUTE).toISOString() } : null, updatedAt: new Date(now).toISOString() })),
  agents: [{ agent_id: 'web-1', agent_created_at: new Date(now - 10 * 60 * MINUTE).toISOString() }] };
  const floor = agentFloorModel(dashboardModel(project, events, { now, complete: true }), events);
  return { floor, html: agentFloorHtml(floor), at: ago => new Date(now - ago * MINUTE).toISOString() };
}

test('every hold age counts from that hold\'s own claim or reservation, even when the seat holds two at once [N26]', () => {
  const lease = ago => ({ leaseUntil: new Date(Date.parse('2026-10-28T12:00:00Z') - ago * MINUTE).toISOString() });
  const until = ago => ({ until: lease(ago).leaseUntil });
  const both = floorFor([[1, 'submitted', 'web-1', -120], [2, 'claimed', 'web-1', -120]], [
    ['add', 'person', 1, 90], ['add', 'person', 2, 90], ['claim', 'web-2', 1, 80, lease(-60)], ['submit', 'web-2', 1, 40],
    ['reserve', 'web-1', 1, 20, until(-120)], ['claim', 'web-1', 2, 5, lease(-120)],
  ]);
  assert.match(both.html, /#2 building 5m<\/span>/u, 'the build counts from its own claim');
  assert.match(both.html, /#1 reviewing 20m<\/span>/u, 'the review still counts from its reservation while the seat also builds');
  const survived = floorFor([[1, 'submitted', 'web-1', -120], [2, 'submitted', null, 0]], [
    ['add', 'person', 1, 90], ['add', 'person', 2, 90], ['claim', 'web-2', 1, 80, lease(-60)], ['submit', 'web-2', 1, 40],
    ['reserve', 'web-1', 1, 30, until(-120)], ['claim', 'web-1', 2, 20, lease(-120)], ['submit', 'web-1', 2, 10],
  ]);
  assert.match(survived.html, /#1 reviewing 30m<\/span>/u, 'a review outlives the build that overlapped it');
  const renewed = floorFor([[1, 'claimed', 'web-1', -60]], [
    ['add', 'person', 1, 400], ['claim', 'web-1', 1, 300, lease(180)], ['claim', 'web-1', 1, 200, lease(60)], ['claim', 'web-1', 1, 100, lease(-60)],
  ]);
  assert.match(renewed.html, /#1 building 5\.0h<\/span>/u, 'a renewed hold that began before the window reads its whole age');
});

test('a ready item\'s age counts from the moment it came free, lapsed leases included [N26]', () => {
  const now = Date.parse('2026-10-28T12:00:00Z'), lease = ago => ({ leaseUntil: new Date(now - ago * MINUTE).toISOString() });
  const { floor } = floorFor([[1, 'open', null, 0], [2, 'open', null, 0], [3, 'open', null, 0]], [
    ['add', 'person', 1, 300], ['add', 'person', 2, 300], ['add', 'person', 3, 300],
    ['claim', 'web-1', 1, 180, lease(60)],
    ['claim', 'web-1', 2, 170, lease(150)], ['claim', 'web-1', 2, 150, lease(30)],
    ['claim', 'web-1', 3, 120, lease(-60)], ['release', 'web-1', 3, 45],
  ]);
  const ready = floor.queues.find(entry => entry.key === 'ready').rows.map(({ item, at }) => [item.id, (now - at) / MINUTE]);
  assert.deepEqual(ready, [[1, 60], [2, 30], [3, 45]], 'free since the lease ran out, the renewed lease ran out, or the release');
});

test('the floor keeps its own address and its way back to the Dashboard [N26,N38]', () => {
  // The /live-style Dashboard (#6847) draws its own Agents table, which the Agents notch opens; the floor stays at /dashboard/floor.
  assert.match(agentFloorHtml(floorAt(seeded.now).floor, { back: '/dashboard' }), /<a class="link" href="\/dashboard" data-tab="dashboard">← Dashboard<\/a>/u);
  // The page embeds these two functions' text; neither can reach a board by itself, so the floor reads what the Dashboard read.
  for (const embedded of [agentFloorModel, agentFloorHtml]) {
    assert.doesNotMatch(embedded.toString(), /\bssh\b|child_process|fetch\(|\bapi\(|import\(/u, `${embedded.name} reads only the Dashboard's model and history`);
  }
});

test('the floor\'s idle count leaves out a gone seat and an advisor and still counts a live idle builder [C7]', () => {
  const project = structuredClone(seeded.input.project), events = structuredClone(seeded.input.events);
  const at = minutes => new Date(seeded.clockBase + minutes * MINUTE).toISOString();
  for (const [id, lane, presence] of [['gone-1', 'web', 'gone'], ['advisor-1', 'advisor', 'live']]) {
    events.push({ event_id: events.length + 1, event_kind: 'join', item_id: null, event_by: id, event_at: at(0), event_detail: JSON.stringify({ lane }) },
      { event_id: events.length + 2, event_kind: 'shout', item_id: null, event_by: id, event_at: at(10), event_detail: JSON.stringify({ to: 'all', text: 'Quiet since.' }) });
    project.agents.push({ agent_id: id, agent_lane: lane, presence, agent_created_at: at(0) });
  }
  project.sequence = events.length;
  const withSeats = agentFloorModel(dashboardModel(project, events, { now: seeded.now, complete: true }), events);
  const plain = floorAt(seeded.now).floor;
  const group = key => withSeats.groups.find(entry => entry.key === key).agents.map(agent => agent.id);
  assert.deepEqual(group('between items'), ['quiet-1'], 'a live idle builder is still counted as idle');
  assert.deepEqual(group('apart'), ['advisor-1', 'gone-1'], 'the gone seat and the advisor sit apart');
  assert.equal(withSeats.numbers.between, plain.numbers.between, 'neither adds to the idle count');
  assert.equal(withSeats.numbers.live, plain.numbers.live, 'neither is a live seat at work');
  assert.equal(withSeats.time.idle, plain.time.idle, 'neither adds holding-nothing time');
  assert.match(agentFloorHtml(withSeats, { back: '/dashboard' }), /Gone or advising · 2/u);
});
