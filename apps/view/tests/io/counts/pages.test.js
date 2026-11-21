/** One number in one place: a real board's state carries the shared counts, and every page shows the same one (#7310) [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as store from '../../../../../packages/store/index.js';
import { costAnalytics } from '../../../../../packages/stats/index.js';
import { projectState } from '../../../src/io/serve.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { activityFlow } from '../../../src/logic/activity/flow.js';
import { activityPageHtml } from '../../../src/logic/activity/page.js';
import { activityStart } from '../../../src/logic/activity/slot.js';
import { pipelineWatchModel } from '../../../src/logic/pipeline/watch.js';
import { pipelineWatchHtml } from '../../../src/logic/pipeline/watch.js';
import { cockpitSidebar } from '../../../src/logic/cockpit/sidebar.js';
import { pageRenderScript } from '../../../src/io/page/render.js';
import { ruleListModel } from '../../../src/logic/rules.js';
import { boardCounts } from '../../../src/logic/counts.js';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';

/** One function's source from a generated page script, from its declaration to the next doc comment. */
function slice(script, name) {
  const start = script.indexOf('function ' + name + '(');
  const end = script.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start, 'the page script declares ' + name);
  return script.slice(start, end);
}

/** The notch as the page draws it: navNumbers from the sidebar script, then drawNav writing into stand-in nodes. */
function notch(project) {
  const nodes = new Map();
  const node = () => ({ textContent: '', classList: { toggle() {} }, setAttribute() {}, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); } });
  const shell = node();
  const context = { $: id => (id === 'notch' ? shell : node()), document: { querySelectorAll: () => [] }, notchHover: {}, nextMilestone: () => null,
    personNeeds: () => { throw new Error('the notch read its own rulings, not the shared count'); },
    workingAgents: () => { throw new Error('the notch counted its own agents, not the shared count'); },
    stateOf: item => item.status === 'claimed' ? 'building' : item.status === 'submitted' ? 'verify' : item.status === 'verified' ? 'verified' : 'open', agentName: id => id };
  const numbers = runInNewContext(slice(cockpitSidebar({ COMMAND_SOURCE: '', groupActivityModel() {}, groupNeedsHtml() {}, groupEventHtml() {} }), 'navNumbers') + '\nnavNumbers(project)', { ...context, project });
  runInNewContext(slice(pageRenderScript(), 'drawNav') + '\ndrawNav(project, numbers)', Object.assign(context, { project, numbers }));
  return { agents: Number(shell.querySelector('[data-notch="agents"]').textContent), rulings: Number(shell.querySelector('[data-notch="rulings"]').textContent), ids: [...numbers.agentIds] };
}

/** The number in an element tagged data-count="<name>" of some markup. */
const tagged = (html, name) => Number(html.match(new RegExp('data-count="' + name + '">(\\d+)<', 'u'))?.[1]);

/** Every page's agents, runners and sent back for one state, each drawn the way its page draws it. */
function pages(state, now) {
  const top = notch(state);
  const events = state.events.toReversed();
  const dash = dashboardModel(state, events, { now, complete: true, working: top.ids });
  const dashHtml = dashboardHtml(dash);
  const flow = activityFlow(state, events, { now, working: top.ids });
  const actHtml = activityPageHtml(flow, activityStart(flow), { width: 740 });
  return { top, dash, dashHtml, flow, actHtml,
    agents: { top: top.agents, dashboard: dash.totals.working, activity: tagged(actHtml, 'agents') },
    runners: { dashboard: tagged(dashHtml, 'runners') ?? 0, activity: tagged(actHtml, 'runners') } };
}

/** A real board: two seats, one holding a claim, a ruling for the person, and a reject, a reopen and an accept in the last hour. */
function busyBoard(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile);
  const make = title => cellItem(board, { lane: 'web', title, specIds: ['G1'], criterion: 'The fixture item is valid.', check: 'true',
    brief: 'Files:\n- web/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- ' + title + ' passes.' }).item_id;
  const builder = cellSeat(board, { lane: 'web', path: project.repo + '/a' });
  cellSeat(board, { lane: 'web', path: project.repo + '/b' });
  const building = make('Building'), back = make('Sent back'), reopened = make('Reopened'), passed = make('Passed');
  cellClaim(board, building, builder, { root: project.repo });
  const event = (minutes, kind, item) => board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'web-9', ?, ?, '{}')")
    .run(new Date(Date.now() - minutes * 60_000).toISOString(), kind, item);
  event(30, 'reject', back); event(20, 'reopen', reopened); event(40, 'accept', passed);
  store.shout(board, { from: 'coordinator', to: store.PERSON, text: 'Which way?', lanes: ['coordinator'], decision: true });
  return { project, board, builder };
}

test('view.x-io-counts-pages.clause-1-agents-and-runners-come-from: clause 1: agents and runners come from the state\'s one count, so the top bar, Dashboard and Activity show the same number [N26]', t => {
  const { project, board, builder } = busyBoard(t);
  const state = projectState(project.repo, { board }), now = Date.now();
  assert.equal(state.counts.agents, 1, 'the claim holder is the one agent at work');
  assert.deepEqual(state.counts.agentIds, [builder.id]);
  const shown = pages(state, now);
  assert.deepEqual(shown.agents, { top: 1, dashboard: 1, activity: 1 }, 'every page shows the shared agents count');
  assert.deepEqual(shown.runners, { dashboard: state.counts.runners, activity: state.counts.runners }, 'every page shows the shared runners count');

  // A machine with runners: the same state read gives the Dashboard and Activity the same count.
  const runners = { runners: [1, 2, 3].map(runner => ({ runner, busy: runner === 1, cpu: 40, ram: 30, jobs: runner === 1 ? [{ kind: 'test' }] : [] })), runs: [] };
  const withRunners = { ...state, dashboardRunners: runners };
  withRunners.counts = boardCounts(withRunners, now);
  assert.deepEqual(pages(withRunners, now).runners, { dashboard: 3, activity: 3 });
  // A page whose own list disagrees still shows the shared count, never its own.
  const drifted = { ...withRunners, counts: { ...withRunners.counts, agents: 2, agentIds: [...withRunners.counts.agentIds, 'web-2'], runners: 4 } };
  const shownDrifted = pages(drifted, now);
  assert.deepEqual(shownDrifted.runners, { dashboard: 4, activity: 4 });
  assert.equal(shownDrifted.agents.dashboard, 2);
  assert.equal(shownDrifted.agents.activity, 2);
});

test('view.x-io-counts-pages.clause-1-a-fresh-board-shows-the: clause 1: a fresh board shows the same agents and runners on every page, the claim holder at work and no runner [N26]', t => {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile);
  const seat = cellSeat(board, { lane: 'web', path: project.repo + '/a' });
  const id = cellItem(board, { lane: 'web', title: 'First item', specIds: ['G1'], criterion: 'The fixture item is valid.', check: 'true',
    brief: 'Files:\n- web/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- First item passes.' }).item_id;
  const empty = projectState(project.repo, { board });
  assert.deepEqual({ agents: empty.counts.agents, runners: empty.counts.runners, rulings: empty.counts.rulings, sentBack: empty.counts.sentBack.count }, { agents: 0, runners: 0, rulings: 0, sentBack: 0 });
  assert.deepEqual(pages(empty, Date.now()).agents, { top: 0, dashboard: 0, activity: 0 });
  cellClaim(board, id, seat, { root: project.repo });
  const state = projectState(project.repo, { board });
  const shown = pages(state, Date.now());
  assert.deepEqual(shown.agents, { top: 1, dashboard: 1, activity: 1 }, 'the seat holding the first claim is at work on every page');
  assert.deepEqual(shown.runners, { dashboard: 0, activity: 0 });
});

test('view.x-io-counts-pages.clause-2-the-top-bar-counts-the: clause 2: the top bar counts the calls only the person can make, and Spec, Doctrine and Activity each name what their Rulings count is [N26]', t => {
  const { project, board } = busyBoard(t);
  const state = projectState(project.repo, { board }), now = Date.now();
  assert.equal(state.counts.rulings, state.needs.length);
  assert.ok(state.counts.rulings >= 1, 'the decision shout is a ruling');
  const shown = pages(state, now);
  assert.equal(shown.top.rulings, state.counts.rulings, 'the notch shows the shared rulings count');
  for (const kind of ['spec', 'doctrine']) {
    const rows = ruleListModel([{ id: 'G9', status: 'draft', text: 'A draft.' }], { kind, filter: 'decide' });
    assert.match(rows.decideTitle, new RegExp('^1 ' + kind + ' rows waiting for a ruling; the top bar counts the calls only you can make$', 'u'));
  }
  assert.match(shown.actHtml, /data-act-go="ruling" title="Rulings raised in this window, not the top bar count"/u, 'Activity names its window count');
});

test('view.x-io-counts-pages.clause-3-sent-back-is-a-reject: clause 3: sent back is a reject or a reopen on the Dashboard, Pipeline and Cost, and no sent-back dash sits beside a Rework share [N26]', t => {
  const { project, board } = busyBoard(t);
  const state = projectState(project.repo, { board }), now = Date.now();
  assert.deepEqual(state.counts.sentBack, { count: 2, verdicts: 3, share: 2 / 3, hours: 4 }, 'the reject and the reopen, over three verdicts');
  const shown = pages(state, now);
  assert.equal(shown.dash.totals.sentBack, 2, 'the Dashboard hero reads the shared count');
  assert.equal(shown.dash.flow.sentBack, 2, 'the Dashboard flow reads the shared count');
  assert.match(shown.dashHtml, /2 sent back/u);
  const events = state.events.toReversed();
  const compare = { available: true, current: { stageShares: { rework: 0.57 } }, previous: { stageShares: { rework: 0.38 } }, change: {} };
  const watch = pipelineWatchModel({ ...state, statsComparison: compare }, events, { now, windowMinutes: 60 });
  const measure = watch.time.measures.find(entry => entry.key === 'sent-back');
  assert.equal(measure.value, 2 / 3, 'Pipeline counts the reject and the reopen over the same verdicts');
  // A window with no verdict: the share reads 0%, never a dash beside the Rework share.
  const quiet = pipelineWatchModel({ ...state, statsComparison: compare }, events.filter(event => !['accept', 'reject', 'reopen'].includes(event.event_kind)), { now, windowMinutes: 60 });
  const html = pipelineWatchHtml(quiet), time = html.slice(0, html.indexOf('</section>'));
  assert.match(time, /Rework <b[^>]*>38% → 57%<\/b>/u, 'the Time card shows the Rework share');
  assert.match(time, /<b>67%<\/b> sent back/u, 'beside it, the shared four-hour share stands in for the empty window');
  assert.doesNotMatch(time, /<b>—<\/b> sent back/u, 'no dash sits beside it');
  // Cost counts an item sent back by the same two kinds before it landed.
  const cost = kind => costAnalytics({ items: [{ id: 1, title: 'One' }], agents: [], window: '7d', now: new Date(now), timeZone: 'UTC', modelPresentation: name => ({ key: name, name }),
    events: [{ event_id: 1, event_kind: 'submit', item_id: 1, event_by: 'web-1', event_at: new Date(now - 3e6).toISOString(), event_detail: '{}' },
      { event_id: 2, event_kind: kind, item_id: 1, event_by: 'web-2', event_at: new Date(now - 2e6).toISOString(), event_detail: '{}' },
      { event_id: 3, event_kind: 'merged', item_id: 1, event_by: 'coordinator', event_at: new Date(now - 1e6).toISOString(), event_detail: '{}' }] }).totals.sentBack.items;
  assert.deepEqual(['reject', 'reopen', 'accept'].map(cost), [1, 1, 0]);
});
