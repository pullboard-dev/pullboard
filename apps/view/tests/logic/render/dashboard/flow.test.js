/** Where the work is: five step cards with arrows and the sent-back loop; each opens Items filtered to its step [N26,N38]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { selectItemsView } from '../../../../src/logic/selection.js';

const now = Date.parse('2026-11-12T18:00:00Z');
const at = minutes => new Date(now - minutes * 60_000).toISOString();
const until = new Date(now + 30 * 60_000).toISOString();

/** A small board with every step occupied, and history holding sends back inside and outside four hours. */
function board() {
  const items = [
    { id: 1, title: 'Ready one', status: 'open', lane: 'web', updatedAt: at(5) },
    { id: 2, title: 'Ready two', status: 'open', lane: 'web', updatedAt: at(5) },
    { id: 3, title: 'Waits on 1', status: 'open', lane: 'web', blockedBy: [1], updatedAt: at(5) },
    { id: 4, title: 'Being built', status: 'claimed', lane: 'web', claim: { by: 'web-1', until }, updatedAt: at(5) },
    { id: 5, title: 'Reviewed now', status: 'submitted', lane: 'web', reviewer: 'tests-1', reviewUntil: until, updatedAt: at(5) },
    { id: 6, title: 'Waits for a reviewer', status: 'submitted', lane: 'web', updatedAt: at(5) },
    { id: 7, title: 'Passed', status: 'verified', lane: 'web', updatedAt: at(5) },
    { id: 8, title: 'Landed', status: 'verified', lane: 'web', merged: true, updatedAt: at(5) },
  ];
  const events = [
    { event_id: 1, event_kind: 'reject', item_id: 6, event_by: 'tests-1', event_at: at(300), event_detail: '{}' },
    { event_id: 2, event_kind: 'reject', item_id: 5, event_by: 'tests-1', event_at: at(90), event_detail: '{}' },
    { event_id: 3, event_kind: 'reopen', item_id: 4, event_by: 'coordinator', event_at: at(30), event_detail: '{}' },
    { event_id: 4, event_kind: 'merged', item_id: 8, event_by: 'coordinator', event_at: at(60), event_detail: JSON.stringify({ commit: 'c'.repeat(40) }) },
  ];
  const project = { items, events, sequence: events.length, agents: [{ agent_id: 'web-1' }, { agent_id: 'tests-1' }],
    dashboardLanded: [{ id: 8, commit: 'c'.repeat(40) }], dashboardNext: [2, 1] };
  return { project, events, items };
}

/** The rendered Where the work is section. */
function flow(html) {
  const start = html.indexOf('aria-label="Where the work is"');
  assert.notEqual(start, -1, 'Where the work is renders');
  return html.slice(start, html.indexOf('</section>', start));
}

test('clause 1: five cards in order, Ready, Building, In review, Passed, Landed, each with a count and a caption, joined by arrows [N26]', () => {
  const { project, events } = board();
  const html = flow(dashboardHtml(dashboardModel(project, events, { now, complete: true })));
  const cards = [...html.matchAll(/<button class="dash-step (\w+)"[^>]*>.*?<\/svg>([^<]+)<\/span><b>([^<]+)<\/b><small>([^<]+)<\/small><\/button>/gu)]
    .map(([, key, name, count, caption]) => [key, name, count, caption]);
  assert.deepEqual(cards, [
    ['ready', 'Ready', '2', '1 more wait on others'],
    ['building', 'Building', '1', 'one item per agent'],
    ['review', 'In review', '2', '1 being checked now'],
    ['passed', 'Passed', '1', 'landing next'],
    ['landed', 'Landed', '1', 'in the last 24 hours'],
  ]);
  // The arrows sit between the cards: a single grid of five steps, each but the last drawing its arrow after itself.
  assert.match(html, /<div class="dash-steps">(<button class="dash-step [^"]+"[\s\S]*?<\/button>){5}<\/div>/u);
  assert.doesNotMatch(html, /aria-label="Pipeline"|dash-stage-link/u, 'the old chip strip is gone');
});

test('clause 2: the sent-back loop under the cards names how many went back to fix in 4 h [N26]', () => {
  const { project, events } = board();
  const html = flow(dashboardHtml(dashboardModel(project, events, { now, complete: true })));
  assert.match(html, /<div class="dash-loop" data-dashboard-loop><span class="dash-loop-line" aria-hidden="true"><\/span>/u, 'the dashed loop line from In review back to Building');
  assert.match(html, /<b>2<\/b> sent back to fix in 4 h<\/span><span class="dash-loop-note">· a different agent reviews every item<\/span>/u,
    'one reject and one reopen inside four hours; the reject five hours ago is outside');
  const none = flow(dashboardHtml(dashboardModel({ ...project, sequence: 0 }, [], { now, complete: true })));
  assert.match(none, /<b>0<\/b> sent back to fix in 4 h/u, 'no sends back reads 0');
});

test('clause 3: clicking a card opens Items filtered to that step [N26]', () => {
  const { project, events, items } = board();
  const model = dashboardModel(project, events, { now, complete: true });
  const html = flow(dashboardHtml(model));
  const lists = Object.fromEntries([...html.matchAll(/data-dashboard-step="(\w+)" data-dashboard-list="(\w+)"/gu)].map(([, step, list]) => [step, list]));
  assert.deepEqual(lists, { ready: 'next', building: 'building', review: 'review', passed: 'passed', landed: 'landed' });
  // The page's click handler maps each list to an Items state; this is the same table actions.js uses.
  const stateFor = { review: 'verify', next: 'ready', building: 'building', passed: 'passed', landed: 'landed' };
  const stateOf = item => item.status === 'claimed' ? 'building' : item.status === 'submitted' ? 'verify' : item.status === 'verified' ? 'verified' : 'open';
  const stateById = new Map(items.map(item => [item.id, { state: stateOf(item), gated: Boolean(item.blockedBy?.length), merged: Boolean(item.merged) }]));
  const shown = list => selectItemsView({ items, stateById, state: stateFor[list], lane: null, readyIds: model.next.map(item => item.id),
    dashboardList: list, dashboardNext: project.dashboardNext }).shown.map(item => item.id);
  assert.deepEqual(shown(lists.ready), [2, 1], 'Ready opens the ready items in rank order');
  assert.deepEqual(shown(lists.building), [4], 'Building opens the item being built');
  assert.deepEqual(shown(lists.review).sort(), [5, 6], 'In review opens the submitted items');
  assert.deepEqual(shown(lists.passed), [7], 'Passed opens the items that passed review and have not landed');
  assert.deepEqual(shown(lists.landed), [8], 'Landed opens the landed items');
  const label = list => selectItemsView({ items, stateById, state: stateFor[list], lane: null }).stateOptions.find(option => option.value === stateFor[list])?.label;
  assert.deepEqual(['building', 'passed', 'landed'].map(label), ['Building', 'Passed, landing next', 'Landed'], 'the Items filter names the chosen step');
});
