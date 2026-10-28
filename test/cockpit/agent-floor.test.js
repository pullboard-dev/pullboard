/** @pullboard-test-gui */
/** The agent floor opens from the Dashboard at its own address and shows the whole board, live [N26,N38]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { agentFloorHtml } from '../../src/view/agent-floor-render.js';
import { agentFloorModel } from '../../src/view/agent-floor-model.js';
import { dashboardHtml } from '../../src/view/dashboard-render.js';
import { dashboardModel } from '../../src/view/dashboard-model.js';
import { accept } from './fixture.js';
import { boardId } from './fixture.js';
import { build } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { earlier } from './fixture.js';
import { fetchLive } from './fixture.js';
import { machine } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { press } from './fixture.js';
import { proofShot } from './fixture.js';
import { project } from './fixture.js';
import { startView } from './fixture.js';

const MINUTE = 60_000;
/** The seeded board, its running view, and the exact API reads the page itself makes. */
const seeded = {};

/** Read the board's state and complete event history through the same API the Dashboard reads. */
async function boardInput(view, root) {
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

// One real board for every case: two landed, one accepted, two in review, one sent back, three ready, one building.
before(async () => {
  const box = machine();
  const alpha = project(box, 'agent-floor', undefined, {
    lease: '2h', reviewLease: '3h',
    lanes: { web: { owns: ['web/'], specs: ['G'] }, tests: { owns: [], specs: ['G'] }, quiet: { owns: [], specs: ['G'] } },
  });
  const titles = ['Landed one', 'Landed two', 'Accepted, waiting to land', 'In review with a reviewer', 'In review, nobody yet',
    'Sent back once', 'Ready one', 'Ready two', 'Ready three'];
  for (const title of titles) {
    box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The fixture row shows on the agent floor.',
      '--check', 'test -f pullboard.json', '--wait');
  }
  for (const id of [1, 2]) {
    build(box, alpha, id, `landed-${id}.txt`);
    accept(box, alpha, id);
    box.git(alpha.repo, 'merge', '--no-ff', '-m', `chore: land floor item ${id}`, alpha.itemBranches.get(`${alpha.baseBranch}:${id}`));
    box.run(alpha.repo, 'merged', String(id), box.git(alpha.repo, 'rev-parse', 'HEAD'));
  }
  build(box, alpha, 3, 'accepted.txt');
  accept(box, alpha, 3);
  build(box, alpha, 4, 'review-4.txt');
  build(box, alpha, 5, 'review-5.txt');
  build(box, alpha, 6, 'sent-back.txt');
  const reviewer = join(box.dir, 'agent-floor-reviewer');
  box.git(alpha.repo, 'worktree', 'add', '-q', '-b', 'tests/agent-floor-reviewer', reviewer, 'main');
  box.run(reviewer, 'join', 'tests', '--model', 'Floor reviewer');
  // The reviewer sends #6 back from its submitted commit, so the red mark sits on the reviewer's own line.
  box.git(reviewer, 'switch', '-q', '--detach', alpha.itemBranches.get(`${alpha.baseBranch}:6`));
  box.run(reviewer, 'verify', '6', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'shows on the agent floor', '--note', 'the floor fixture sends it back');
  box.git(reviewer, 'switch', '-q', '--detach', 'main');
  earlier(alpha.repo, Date.now(), board => store.reserveReview(board, 4, { agentId: 'tests-1', leaseMs: 3 * 60 * MINUTE, policy: 'any' }));
  // web-1 claims its next ready item, which it is building now.
  box.run(alpha.web, 'claim', '7');
  for (const index of [1, 2]) {
    const path = join(box.dir, `agent-floor-quiet-${index}`);
    box.git(alpha.repo, 'worktree', 'add', '-q', '-b', `tests/agent-floor-quiet-${index}`, path, 'main');
    box.run(path, 'join', 'quiet', '--model', `Floor seat ${index}`);
    seeded[`quiet${index}`] = path;
  }
  const clockBase = Date.now();
  earlier(alpha.repo, clockBase + 10 * MINUTE, board => store.shout(board, { from: 'quiet-1', to: 'all', text: 'Between items on the floor.', lanes: ['web'] }));
  Object.assign(seeded, { box, alpha, clockBase, now: clockBase + 25 * MINUTE, view: await startView(box) });
  seeded.input = await boardInput(seeded.view, alpha.repo);
  seeded.held = seeded.input.project.items.find(item => item.status === 'claimed');
}, { timeout: 120_000 });

after(async () => { await seeded.view?.stop(); });

test('the floor\'s headline counts live agents, builders, reviewers and 24-hour landings from the board [N26]', () => {
  const { model, floor, html } = floorAt(seeded.now);
  const headline = section(html, 'Headline');
  assert.match(headline, /<h1>3 agents, 1 building, 1 reviewing, <em>2 landed in 24 hours\.<\/em><\/h1>/u);
  assert.equal(floor.numbers.landed, model.totals.day, 'the floor and the Dashboard count the same landings');
  assert.equal(floor.numbers.building, model.claims.length, 'the floor and the Dashboard count the same builders');
});

test('the floor\'s full row of numbers names every count the person asked for [N26]', () => {
  const { floor, html } = floorAt(seeded.now);
  const band = section(html, 'Board numbers');
  const expected = { live: 3, building: 1, reviewing: 1, between: 1, landed: 2, accepted: 3, 'sent-back': 1, 'in-review': 2, waiting: 1, ready: 3, shouts: 1 };
  const labels = ['Agents live', 'Building', 'Reviewing', 'Between items', 'Landed · 24 h', 'Accepted', 'Sent back', 'In review', 'Waiting to land', 'Ready to build', 'Shouts'];
  const shown = [...band.matchAll(/data-floor-stat="([^"]+)" data-value="([^"]*)"><b>[^<]*<\/b><span>([^<]*)<\/span>/gu)].map(match => [match[1], match[2], match[3]]);
  assert.deepEqual(shown.map(([key]) => key), Object.keys(expected), 'eleven numbers, in the person\'s order');
  assert.deepEqual(shown.map(([, , label]) => label), labels);
  for (const [key, value] of shown) assert.equal(value, String(expected[key]), `${key} reads the seeded board`);
  assert.match(band, /4 seen in 4 h/u, 'every seat seen in the window, quiet ones included');
  assert.match(band, /1 waiting for a reviewer/u);
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
  for (const [group, count] of [['Building', 1], ['Reviewing', 1], ['Between items', 1], ['Quiet for 20 min or more', 1]]) {
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

test('the Dashboard\'s Agents card ends with the link to the floor at its own address [N26,N38]', () => {
  const model = dashboardModel(seeded.input.project, seeded.input.events, { now: seeded.now, complete: true });
  const agents = section(dashboardHtml(model, { floorHref: '/dashboard/floor' }), 'Agents');
  assert.match(agents, /<a class="link dash-floor-link" href="\/dashboard\/floor" data-tab="dashboard" data-detail="floor">Open the agent floor →<\/a>$/u);
  assert.match(agentFloorHtml(floorAt(seeded.now).floor, { back: '/dashboard' }), /<a class="link" href="\/dashboard" data-tab="dashboard">← Dashboard<\/a>/u);
  // The page embeds these two functions' text; neither can reach a board by itself, so the floor reads what the Dashboard read.
  for (const embedded of [agentFloorModel, agentFloorHtml]) {
    assert.doesNotMatch(embedded.toString(), /\bssh\b|child_process|fetch\(|\bapi\(|import\(/u, `${embedded.name} reads only the Dashboard's model and history`);
  }
});

// Chrome startup, two widths and one live board move share this 90-second journey budget.
test('the floor opens from the Dashboard, has its own address, refreshes live and fits a phone [N26,N38]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the agent floor journey.');
  const { box, alpha, view } = seeded;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-agent-floor-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && !!document.querySelector('#dashboard .dash-floor-link')`);
    assert.equal(await chrome.stable('document.querySelector("#dashboard [aria-label=Agents]").lastElementChild.textContent'), 'Open the agent floor →');
    await press(chrome, 'document.querySelector("#dashboard .dash-floor-link")');
    await chrome.waitFor('view.tab === "dashboard" && view.addressDetail === "floor" && !!document.querySelector("#dashboard .floor")');
    assert.equal(await chrome.stable('location.pathname'), '/dashboard/floor', 'the floor has its own address');
    for (const name of ['Headline', 'Board numbers', 'Landed per hour', 'Agent time', 'Agents', 'In review', 'Accepted, waiting to land', 'Ready, nobody building', 'Landed · 24 h']) {
      assert.equal(await chrome.stable(`!!document.querySelector('#dashboard .floor [aria-label=${JSON.stringify(name)}]')`), true, `${name} shows`);
    }
    assert.equal(await chrome.stable('document.querySelector("[data-floor-stat=building]").dataset.value'), '1', 'the page reads the board\'s live claim');
    const shouts = Number(await chrome.stable('document.querySelector("[data-floor-stat=shouts]").dataset.value'));
    box.run(seeded.quiet2, 'shout', 'all', 'A live move the floor picks up.');
    await chrome.waitFor(`document.querySelector("[data-floor-stat=shouts]")?.dataset.value === "${shouts + 1}"`);
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      await chrome.waitFor(`innerWidth === ${width}`);
      const layout = await chrome.stable(`(() => {
        const inside = element => { const rect = element.getBoundingClientRect(); return rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1; };
        const lines = [...document.querySelectorAll('#dashboard .floor-agent:not(.floor-axis) > svg')];
        return { fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          numbers: [...document.querySelectorAll('.floor-number')].every(inside), queues: [...document.querySelectorAll('.floor-queue')].every(inside),
          lines: lines.length, narrowest: Math.min(...lines.map(line => line.getBoundingClientRect().width)) };
      })()`);
      assert.equal(layout.fits, true, `no sideways scroll at ${width}px`);
      assert.equal(layout.numbers && layout.queues, true, `numbers and queues sit inside ${width}px`);
      assert.equal(layout.lines, 4, 'every agent keeps its line');
      assert.ok(layout.narrowest > (width < 700 ? 250 : 160), `each timeline keeps a readable width at ${width}px: ${layout.narrowest}`);
      await proofShot(chrome, 'agent-floor', width);
    }
    await press(chrome, 'document.querySelector("#dashboard .floor-crumbs a")');
    await chrome.waitFor('view.addressDetail === null && !!document.querySelector("#dashboard .dash-floor-link")');
    assert.equal(await chrome.stable('location.pathname'), '/dashboard');
    await chrome.send('Page.navigate', { url: view.base + '/dashboard/floor' });
    await chrome.waitFor('typeof view !== "undefined" && view.addressDetail === "floor" && !!document.querySelector("#dashboard .floor [aria-label=Agents]")');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
});
