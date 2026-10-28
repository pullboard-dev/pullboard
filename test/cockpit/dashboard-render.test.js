/** @pullboard-test-gui */
/** Exercise populated Dashboard rendering from a private native API fixture [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { dashboardHtml } from '../../src/view/dashboard-render.js';
import { dashboardModel } from '../../src/view/dashboard-model.js';
import { roadmapSummary } from '../../src/view/roadmap-summary.js';
import { accept, boardId, build, fetchLive, machine, project, startView, earlier } from './fixture.js';

/** Read the exact project summary and complete event prefix used by the live page. */
async function dashboardInput(view, root) {
  const id = await boardId(view, root), headers = { 'x-pullboard-key': view.key };
  const base = `${view.base}/api/v1/boards/${id}`;
  const [stateResponse, eventsResponse] = await Promise.all([
    fetchLive(`${base}/state`, { headers }), fetchLive(`${base}/events?after=0`, { headers }),
  ]);
  assert.equal(stateResponse.status, 200);
  assert.equal(eventsResponse.status, 200);
  const [{ state }, { events }] = await Promise.all([stateResponse.json(), eventsResponse.json()]);
  return { project: { ...state, root }, events };
}

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

// Native Git setup, ten CLI submissions and complete API projections share this 90-second fixture budget.
test('Dashboard renders populated release, chart, agents, landing and capped lists from native history [N26]', { timeout: 90_000 }, async () => {
  const box = machine();
  const alpha = project(box, 'dashboard-render', undefined, {
    lease: '2h', reviewLease: '3h',
    lanes: {
      web: { owns: ['web/'], specs: ['G'] },
      tests: { owns: [], specs: ['G'] },
      quiet: { owns: [], specs: ['G'] },
    },
  });
  // Three genuine merges provide the existing Roadmap pace and estimate; item 4 is accepted but not merged.
  const names = [
    ...Array.from({ length: 3 }, (_, index) => `Landed ${index + 1}`), 'Accepted, waiting to land',
    ...Array.from({ length: 6 }, (_, index) => `In review ${index + 1}`),
    ...Array.from({ length: 10 }, (_, index) => `Ready ${index + 1}`), 'Current builder',
  ];
  for (const title of names) {
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The private fixture row is visible in the real board API.',
      '--check', 'test -f pullboard.json', '--wait');
  }
  for (const id of [1, 2, 3]) {
    build(box, alpha, id, `landed-${id}.txt`);
    accept(box, alpha, id);
    const branch = alpha.itemBranches.get(`${alpha.baseBranch}:${id}`);
    box.git(alpha.repo, 'merge', '--no-ff', '-m', `chore: land dashboard item ${id}`, branch);
    box.run(alpha.repo, 'merged', String(id), box.git(alpha.repo, 'rev-parse', 'HEAD'));
  }
  build(box, alpha, 4, 'accepted-not-merged.txt');
  accept(box, alpha, 4);
  for (let id = 5; id <= 10; id += 1) build(box, alpha, id, `review-${id}.txt`);
  box.run(alpha.web, 'claim', '21'); // Keep one actual builder lease live after all submission commands.

  const reviewerPath = join(box.dir, 'dashboard-render-reviewer');
  box.git(alpha.repo, 'worktree', 'add', '-q', '-b', 'tests/dashboard-render-reviewer', reviewerPath, 'main');
  box.run(reviewerPath, 'join', 'tests', '--model', 'Dashboard rendering reviewer');
  earlier(alpha.repo, Date.now(), board => store.reserveReview(board, 5, {
    agentId: 'tests-1', leaseMs: 3 * 60 * 60_000, policy: 'any',
  }));

  // Two ordinary joined seats sit on opposite sides of the twenty-minute grouping rule.
  const quietPaths = [];
  for (let index = 1; index <= 2; index += 1) {
    const path = join(box.dir, `dashboard-render-quiet-${index}`);
    quietPaths.push(path);
    box.git(alpha.repo, 'worktree', 'add', '-q', '-b', `tests/dashboard-render-quiet-${index}`, path, 'main');
    box.run(path, 'join', 'quiet', '--model', `Dashboard quiet seat ${index}`);
  }
  const clockBase = Date.now();
  earlier(alpha.repo, clockBase + 2 * 60_000, board => store.shout(board, {
    from: 'quiet-1', to: 'person', text: 'A recent dashboard fixture update.', lanes: ['web'],
  }));

  box.run(alpha.repo, 'milestone', 'add', '0.1.0', '--items', Array.from({ length: 21 }, (_, index) => index + 1).join(','));
  box.run(alpha.repo, 'milestone', 'order', '0.1.0', Array.from({ length: 21 }, (_, index) => 21 - index).join(','));
  const view = await startView(box);
  try {
    const input = await dashboardInput(view, alpha.repo);
    const quietModel = dashboardModel(input.project, input.events, { now: clockBase + 21 * 60_000, complete: true });
    assert.equal(quietModel.agents.find(agent => agent.id === 'quiet-1')?.group, 'between items', '19 minutes since activity is not quiet');
    assert.equal(quietModel.agents.find(agent => agent.id === 'quiet-2')?.group, 'quiet', '21 minutes since activity folds the agent into Quiet');
    const quietHtml = dashboardHtml(quietModel);
    const expiredWindow = dashboardModel(input.project, input.events, { now: clockBase + 5 * 60 * 60_000, complete: true });
    assert.ok(!expiredWindow.agents.some(agent => agent.id === 'quiet-2'), 'a real seat with no activity in the four-hour window is excluded, rather than counted quiet');
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
    assert.match(chart, /3 in 24 h · busiest hour 3/u, 'the chart caption uses the actual seeded landing bins');
    assert.match(chart, /class="dash-pace-tag"/u, 'today pace is labeled on the line');
    assert.equal([...chart.matchAll(/<span>/gu)].length, 5, 'the chart has four six-hour labels and now');

    assert.match(agents, /aria-label="web-1 last four hours"/u);
    assert.match(agents, /aria-label="tests-1 last four hours"/u);
    const buildSegment = model.agents.find(agent => agent.id === 'web-1')?.segments.find(segment => segment.item === 21);
    assert.ok(buildSegment, 'the active build has a timeline segment');
    assert.match(agents, new RegExp(`#21 building · ${Math.round((buildSegment.end - buildSegment.start) / 60_000)}m`, 'u'));
    assert.match(section(html, 'Agent time'), /Building[\s\S]*Reviewing[\s\S]*Between items/u, 'agent time reports all three categories');
  } finally {
    await view.stop();
  }
});
