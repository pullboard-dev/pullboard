/** @pullboard-test-input apps/view/src/io/serve.js */
/** @pullboard-world-pin reads serve.js source to prove the address pattern that serves /<board>/pipeline; the page itself needs a browser. */
/** The Insights Pipeline page: its sections in the approved order, and every number read from the board's items and events [N26,#6869]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { navPages } from '../../../src/logic/nav.js';
import { pipelineWatchHtml } from '../../../src/logic/pipeline/watch.js';
import { pipelineWatchModel } from '../../../src/logic/pipeline/watch.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z'), MINUTE = 60_000;
const at = offset => new Date(NOW + offset * MINUTE).toISOString();

/** A small board whose every number is known: who claimed, what failed, what landed, and what stands still. */
function board({ gate = true, review = true } = {}) {
  let id = 0;
  const events = [];
  const event = (kind, item, by, offset, detail = {}) => events.push({ event_id: ++id, event_kind: kind, item_id: item, event_by: by, event_at: at(offset), event_detail: JSON.stringify(detail) });
  event('add', 1, 'person', -300, { title: 'Main red: journeys/gate/launches.test.js two cases fail' });
  event('claim', 14, 'core-14', -120); event('submit', 14, 'core-14', -110); event('merged', 14, 'coordinator', -90, { commit: 'b'.repeat(40) });
  event('claim', 2, 'core-2', -45);
  event('claim', 3, 'core-3', -40); event('release', 3, 'sentinel', -30, { reason: 'Seat core-3 has no heartbeat for two minutes or its worktree is gone; claim returned to the queue.', reclaim: { seat: 'core-3' } });
  event('claim', 7, 'core-7', -35); event('submit', 7, 'core-7', -20);
  if (gate) event('gate-run', 7, 'core-7', -18, { run: { green: true } });
  event('claim', 10, 'core-10', -70); event('submit', 10, 'core-10', -60);
  if (gate) event('gate-run', 10, 'core-10', -58, { run: { green: false, failures: [{ file: 'journeys/gate/launches.test.js', name: 'case 1' }] } });
  event('reserve', 10, 'rev-1', -55, { until: at(-50) });
  if (review) event('accept', 10, 'rev-1', -52, { reason: 'CRITERION_MET' });
  event('merged', 10, 'coordinator', -50, { commit: 'a'.repeat(40) });
  event('claim', 9, 'core-9', -30); event('submit', 9, 'core-9', -15);
  if (review) { event('reserve', 9, 'rev-1', -12, { until: at(30) }); event('accept', 9, 'rev-1', -8, { reason: 'CRITERION_MET' }); }
  event('merged', 9, 'coordinator', -5, { commit: 'c'.repeat(40) });
  event('claim', 11, 'core-11', -5);
  event('release', 12, 'core-12', -25, { reason: 'BUDGET: too big for one session' });
  event('release', 12, 'core-13', -15, { reason: 'BUDGET: too big for one session' });
  const item = (itemId, extra) => ({ id: itemId, title: 'Item ' + itemId, lane: 'core', status: 'open', blockedBy: [], updatedAt: at(-200), ...extra });
  const items = [
    item(1, { title: 'Main red: journeys/gate/launches.test.js two cases fail' }),
    item(2, { status: 'claimed', claim: { by: 'core-2', until: at(60) } }),
    item(3), item(4, { blockedBy: [1] }), item(5, { updatedAt: at(-100) }),
    item(6, { status: 'submitted', claim: { by: 'rev-2', until: at(20) } }),
    item(7, { status: 'submitted' }),
    item(8, { status: 'verified' }),
    item(9, { status: 'verified', merged: true }), item(10, { status: 'verified', merged: true }),
    item(11, { status: 'claimed', claim: { by: 'core-11', until: at(60) } }),
    item(12), item(14, { status: 'verified', merged: true }),
  ];
  const project = { items, agents: [{ agent_id: 'core-2', lastMoveAt: at(-45) }], itemHolds: [{ item: 12, reason: 'Released twice: BUDGET, BUDGET' }],
    milestones: [{ name: '0.9.4', items: items.filter(entry => entry.id !== 14).map(entry => ({ id: entry.id })), summary: { left: 11 } }],
    dashboardRunners: { runners: [{ runner: 1, jobs: [{}, {}] }] },
    statsComparison: { available: true, current: { idleShare: 0.39, agentHoursPerLanding: 1.9, stageShares: { build: .46, rework: .21, reviewWait: .14, review: .09, land: .1 } },
      previous: { idleShare: 0.35, agentHoursPerLanding: 2.2, stageShares: { build: .52, rework: .13, reviewWait: .16, review: .1, land: .09 } }, change: { idleShare: 0.04, agentHoursPerLanding: -0.3 } } };
  return { project, events };
}
const href = ids => '/items?state=ids&ids=' + ids.join(',');
const draw = (model, extra = {}) => pipelineWatchHtml(model, { href, itemHref: id => '/items/' + id, ...extra });
const labels = html => [...html.matchAll(/<p class="dash-lbl"[^>]*>(.*?)<\/p>/gu)].map(match => match[1].replace(/<[^>]*>/gu, ''));
const idsOf = html => [...html.matchAll(/data-pipeline-ids="([\d,]+)"/gu)].map(match => match[1].split(',').map(Number));

test('view.logic-pipeline-watch.clock-model: pipelineWatchModel carries the project clock and returns null when absent [C7,N26]', () => {
  const clock = { withoutOwnerDeadline: 2, overdue: 3, oldestOverdueMinutes: 45, byRule: { ready: { count: 1, nextDeadlineAt: NOW, move: 'alarm' } } };
  assert.equal(pipelineWatchModel({ items: [], clock }, [], { now: NOW }).clock, clock);
  assert.equal(pipelineWatchModel({ items: [] }, [], { now: NOW }).clock, null);
});

test('view.logic-pipeline-watch.clock-html: pipelineWatchHtml renders the clock alarm, overdue age, and named group deadlines [C7,N26]', () => {
  const { project, events } = board();
  project.clock = { withoutOwnerDeadline: 2, overdue: 3, oldestOverdueMinutes: 45, byRule: {
    'claim-idle': { count: 1, nextDeadlineAt: NOW + 30 * MINUTE, move: 'release-claim' },
    ready: { count: 1, nextDeadlineAt: NOW + 60 * MINUTE, move: 'alarm' },
  } };
  const html = draw(pipelineWatchModel(project, events, { now: NOW, windowMinutes: 60 }));
  assert.match(html, /items without owner\+deadline: 2/u);
  assert.match(html, /overdue: 3 · oldest 45m/u);
  assert.match(html, /next deadline 12:30 PM · default move release-claim/u);
  assert.match(html, /next deadline 1:00 PM · default move alarm/u);
});

test('view.x-pipeline-watch.clause-1-insights-lists-pipeline-as-its: clause 1: Insights lists Pipeline as its fourth page, and the page draws Time, Flow, Main, Why beside Failures, Not moving, Bouncing, Red tests and This machine in that order [N26,#6869]', () => {
  assert.deepEqual(navPages({ cost: true }).filter(page => page.groupId === 'insights').map(page => page.id), ['dashboard', 'activity', 'cost', 'pipeline'], 'Pipeline is the fourth Insights page');
  assert.equal(navPages().find(page => page.id === 'pipeline').what, 'Why work isn\'t moving');
  const serve = readFileSync(new URL('../../../src/io/serve.js', import.meta.url), 'utf8');
  assert.match(serve, /\(\?:progress\|dashboard\|home\|items\|shouts\|spec\|doctrine\|activity\|pipeline\|roadmap\|cost\|settings\)/u, '/<board>/pipeline serves the page like every other address');
  const { project, events } = board();
  const html = draw(pipelineWatchModel(project, events, { now: NOW, windowMinutes: 60, machine: { cores: 12, load: [3, 2, 1], parts: [], views: [] } }));
  assert.deepEqual(labels(html), ['Time · 1 h vs before', 'Flow · 1 h', 'Main · 24 h', 'Why · 1 h', 'Failures · 1 h', 'Not moving7', 'Bouncing · 12 h', 'Red tests', 'Hand-backs · 1 h', 'This machine']);
  assert.doesNotMatch(html, /\sstyle=/u, 'no inline style: the page\'s policy refuses them');
  for (const [minutes, name] of [[15, '15 min'], [30, '30 min'], [60, '1 h'], [180, '3 h']]) {
    assert.match(draw(pipelineWatchModel(project, events, { now: NOW, windowMinutes: minutes })), new RegExp('Flow · ' + name, 'u'), `the ${name} window names itself in every section it governs`);
  }
});

test('view.x-pipeline-watch.clause-2-the-verdict-the-flow-cards: clause 2: the verdict, the flow cards and the not-moving groups count the board\'s own events and items, and change when it does [N26,#6869]', () => {
  const { project, events } = board();
  const model = pipelineWatchModel(project, events, { now: NOW, windowMinutes: 60 });
  assert.deepEqual([...model.flow.land.ids].sort((a, b) => a - b), [9, 10], 'two landed in the hour: items 9 and 10');
  assert.equal(model.flow.land.landed, 2);
  assert.equal(model.flow.rate.perHour, 2, 'landed per hour is the window\'s landings over its hours');
  assert.deepEqual(model.flow.rate.hours.slice(-2), [1, 2], 'the hourly bars are counted, one per hour: one landing 90 minutes ago, two in the last hour');
  assert.equal(model.flow.rate.hours.reduce((sum, count) => sum + count, 0), model.flow.rate.total, 'the twelve-hour total is the bars\' sum');
  assert.equal(model.flow.build.claimed, 5, 'claims in the hour: items 2, 3, 7, 9, 11 (item 10 was claimed 70 minutes ago)');
  assert.equal(model.flow.build.submitted, 2, 'submits in the hour: items 7 and 9');
  assert.equal(model.flow.build.back, 3, 'hand-backs in the hour: one heartbeat release and two budget releases');
  assert.deepEqual(model.flow.gate && [model.flow.gate.green, model.flow.gate.red, model.flow.gate.pass], [1, 1, 0.5], 'the gate: one green, one red, half pass');
  assert.deepEqual([model.flow.review.accepted, model.flow.review.sentBack], [2, 0]);
  assert.equal(model.time.label, 'Flowing', 'two landed against one before');
  assert.deepEqual([model.time.say.landed, model.time.say.before], [2, 1]);
  assert.equal(model.time.say.loss.stage, 'Build', 'the biggest loss is the stage that handed the most back');
  assert.equal(model.time.say.loss.cause, 'Over budget for one session');
  assert.deepEqual([model.time.say.loss.n, model.time.say.loss.of], [2, 3]);
  assert.match(model.time.doNext, /too big for one session/u, 'what to do follows the cause');
  assert.equal(model.time.measures.find(entry => entry.key === 'landed').delta, 1);
  assert.equal(model.main.commit, 'ccccccc', 'main is the last landing\'s commit');
  assert.deepEqual([model.main.redItems, model.main.redIds], [1, [1]], 'one open Main red item');
  assert.ok(model.main.redMs > 0, 'main red time counts the hours an open Main red item stood');
  assert.equal(model.main.slotsUsed, 2, 'runner slots in use are the runners\' running jobs');
  assert.deepEqual(model.stuck.groups.map(group => [group.key, group.ids]), [
    ['accepted', [8]], ['claimed-idle', [2]], ['released', [3]], ['never-claimed', [1, 5]], ['blocked', [4]], ['held-twice', [12]],
  ], 'each unfinished item sits in exactly one group');
  assert.deepEqual([model.stuck.moving.building, model.stuck.moving.pending, model.stuck.moving.reviewing, model.stuck.moving.gate], [[11], [7], [6], []]);
  assert.equal(model.stuck.count, 7);
  assert.deepEqual(model.bounce.map(row => [row.id, row.releases, row.seats]), [[12, 2, 2]], 'an item released by two seats is bouncing');
  assert.deepEqual(model.reds.map(row => [row.file, row.broke, row.runs, row.owners.map(owner => owner.id)]), [['journeys/gate/launches.test.js', 1, 1, [1]]], 'a red file names the item fixing it');

  // The same page from a different board says different things: no number is a constant.
  const doubled = board();
  for (let index = 0; index < 4; index++) doubled.events.push({ event_id: 1000 + index, event_kind: 'merged', item_id: 20 + index, event_by: 'coordinator', event_at: at(-2 - index), event_detail: JSON.stringify({ commit: 'd'.repeat(40) }) });
  const more = pipelineWatchModel(doubled.project, doubled.events, { now: NOW, windowMinutes: 60 });
  assert.equal(more.flow.land.landed, 6);
  assert.equal(more.flow.rate.perHour, 6);
  assert.notEqual(more.main.commit, undefined);
  const html = draw(model), shorter = draw(pipelineWatchModel(project, events, { now: NOW, windowMinutes: 15 }));
  assert.match(html, /<b>2<\/b> landed · <b>1<\/b> queued/u, 'one accepted item waits to land');
  assert.match(shorter, /<b>1<\/b> landed · <b>1<\/b> queued/u, 'a shorter window counts fewer landings');
  assert.match(pipelineWatchHtml(pipelineWatchModel(project, events, { now: NOW + 3 * 3_600_000, windowMinutes: 60 }), { href }), /Nothing landed in 1 h/u, 'three hours on, nothing landed in the hour');
});

test('view.x-pipeline-watch.clause-2-a-stage-the-board-has: clause 2: a stage the board has not recorded reads a dash, never a zero or a constant [N26,#6869]', () => {
  const { project, events } = board({ gate: false, review: false });
  const model = pipelineWatchModel(project, events, { now: NOW, windowMinutes: 60 });
  assert.equal(model.recorded.gate, false);
  assert.equal(model.recorded.review, false);
  assert.equal(model.flow.gate.green, null);
  assert.equal(model.flow.review.accepted, null);
  const html = draw(model);
  assert.match(html, /<b>—<\/b> green · <b>—<\/b> red/u);
  assert.match(html, /<b>—<\/b> accepted · <b>—<\/b> sent back/u);
  assert.match(html, /<span class="pw-kv"><i class="dash-dot gate"><\/i><b>—<\/b> in the gate<\/span>/u, 'the Moving strip does not guess what is in the gate');
  assert.match(html, /Not recorded/u, 'the Why card says the stage is not recorded rather than that nothing was lost');
  assert.match(html, /gate workers <b>—<\/b>/u, 'a count only this machine can read is a dash without it');
  const empty = pipelineWatchModel(project, [], { now: NOW, windowMinutes: 60 });
  assert.equal(empty.flow.rate.perHour, null, 'no landing recorded in a day: no rate');
  assert.equal(empty.time.say, null);
  assert.match(draw(empty), /Landed per hour<\/span><span class="pw-big">—/u);
  assert.match(pipelineWatchHtml(pipelineWatchModel(project, events, { now: NOW, complete: false }), { href }), /Reading|nothing to compare|—/u);
});

test('view.x-pipeline-watch.clause-2-every-count-and-group-opens: clause 2: every count and group opens its filtered Items page, and an item opens itself [N26,#6869]', () => {
  const { project, events } = board();
  const model = pipelineWatchModel(project, events, { now: NOW, windowMinutes: 60 });
  const html = draw(model);
  const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*data-pipeline-ids="([\d,]+)"/gu)];
  assert.ok(links.length >= 14, `the page carries its counts as links: ${links.length}`);
  for (const [, link, ids] of links) assert.equal(link.replace(/&amp;/gu, '&'), href(ids.split(',')), 'each link opens Items on exactly the ids it carries');
  const all = idsOf(html).map(ids => ids.join(','));
  for (const expected of [model.flow.build.ids, model.flow.land.ids, model.flow.gate.ids, model.flow.review.ids, model.main.redIds, ...model.stuck.groups.map(group => group.ids), model.stuck.moving.building, model.stuck.moving.pending]) {
    assert.ok(all.includes(expected.join(',')), `a link opens Items on ${expected}`);
  }
  for (const group of model.stuck.groups) {
    assert.match(html, new RegExp(`data-pipeline-group="${group.key}".*?<span class="ct">${group.count}</span>`, 'u'), `${group.key}: its count is its item count`);
    assert.ok(html.includes(`<a class="open" href="${href(group.ids).replace(/&/gu, '&amp;')}"`), `${group.key}: Open in Items`);
  }
  const opens = [...html.matchAll(/class="pw-gr( open)?" data-pipeline-group="([a-z-]+)"/gu)].map(match => [match[2], Boolean(match[1])]);
  assert.deepEqual(opens.map(([, open]) => open), opens.map((_, index) => index < 2), 'the two biggest groups open at first, so what is stuck shows at a glance');
  assert.deepEqual([...draw(model, { open: ['blocked'] }).matchAll(/class="pw-gr open" data-pipeline-group="([a-z-]+)"/gu)].map(match => match[1]), ['blocked'], 'once the person opens or closes a group, only the groups they left open are open');
  assert.match(html, /<a class="pw-ir" href="\/items\/2">/u, 'an item row opens the item');
  assert.match(html, /<a class="dash-n pw-code" href="\/items\/12">#12<\/a>/u, 'so does a bouncing item');
  assert.doesNotMatch(html, /href="#"/u, 'no link goes nowhere');
});

test('view.x-pipeline-watch.clause-2-this-machine-draws-the-cpu: clause 2: This machine draws the CPU samples it is given, and the views older than main\'s head [N26,#6869]', () => {
  const { project, events } = board();
  const machine = { cores: 12, load: [113.4, 96, 78], diskFreeGb: 24.3, minutes: 90, gateWorkers: 4, gateQueued: 0, handoffQueued: 2, runnerSlots: 120, runnerUsed: 9,
    views: [{ pid: 1, startedMs: NOW - 90 * MINUTE }, { pid: 2, startedMs: NOW - 2 * MINUTE }],
    parts: [{ part: 'git', now: 2.02, avg: 1.94, peak: 5.78, procs: 17, command: 'git merge-base' }, { part: 'other node', now: 4.08, avg: 4.5, peak: 7.79, procs: 26, command: 'node worktree' }] };
  const model = pipelineWatchModel(project, events, { now: NOW, windowMinutes: 60, machine });
  assert.equal(model.machine.startedBeforeMain, 1, 'one view started before the last landing on main');
  const html = draw(model);
  assert.match(html, /<b>6\.1<\/b> of 12 cores busy/u, 'the cores busy are the parts\' sum');
  assert.match(html, /load <b class="back">113<\/b> \/ <b>96<\/b> \/ <b>78<\/b>/u);
  assert.match(html, /disk free <b>24\.3 GB<\/b>/u);
  assert.match(html, /gate workers <b>4<\/b>/u); assert.match(html, /gates queued <b>0<\/b>/u); assert.match(html, /hand-offs queued <b>2<\/b>/u); assert.match(html, /runner slots <b>9\/120<\/b> 8%/u);
  assert.ok(html.indexOf('>git<') < html.indexOf('other node'), 'the parts are drawn in the order the machine gave them');
  assert.match(html, /title="node worktree">node worktree<\/td>/u, 'the busiest command of each part is shown whole on hover');
  assert.match(html, /<td class="dash-num ink">4\.08<\/td><td class="dash-num">4\.50<\/td><td class="dash-num">7\.79<\/td>/u);
  assert.match(html, /cover the 90 minutes sampled while this page was open/u, 'the note says how long the history is');
  assert.match(draw(pipelineWatchModel(project, events, { now: NOW }), { machineHere: false }), /does not run on the machine/u, 'a page that is not on the machine shows no samples');
});
