/** Clause 2 of #6847: every count, card and chip on the Dashboard opens its filtered Items page [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { selectItemsView } from '../../../../src/logic/selection.js';
import { board } from './fixture.js';
import { now } from './fixture.js';
import { pageScriptPart4 } from '../../../../src/io/page/actions.js';

/** The page script's click handling, as the page serves it. */
const pageActions = () => pageScriptPart4(new Proxy({}, { get: () => '' }));

/** The Items state each Dashboard list opens, read from the page's own click handler so the two cannot drift. */
function stateTable() {
  const table = /view\.state = (\{[^}]+\})\[view\.dashboardList\]/u.exec(pageActions())?.[1];
  assert.ok(table, 'actions.js maps Dashboard lists to Items states');
  return Function('return ' + table)();
}

test('clause 2: each count, card and chip opens Items narrowed to exactly what it counts [N26]', () => {
  const { project, events, items } = board();
  const model = dashboardModel(project, events, { now, complete: true });
  const html = dashboardHtml(model);
  const states = stateTable();
  const stateOf = item => item.status === 'claimed' ? 'building' : item.status === 'submitted' ? 'verify' : item.status === 'verified' ? 'verified' : 'open';
  const gated = item => item.status === 'open' && (Boolean(item.blockedBy?.length) || project.itemHolds.some(hold => hold.item === item.id));
  const stateById = new Map(items.map(item => [item.id, { state: stateOf(item), gated: gated(item), merged: Boolean(item.merged) }]));
  /** The ids Items shows for one Dashboard link. */
  const shown = (list, lane = null) => selectItemsView({ items, stateById, state: states[list], lane, readyIds: model.next.map(item => item.id),
    dashboardList: list, dashboardNext: project.dashboardNext }).shown.map(item => item.id).sort((a, b) => a - b);

  // Every number on the page is a link: a count inside a button with a list, or an item row or chip with its item.
  const links = [...html.matchAll(/<button type="button" class="([^"]*)"( data-dashboard-step="\w+")? data-dashboard-list="([\w-]+)"(?: data-dashboard-lane="(\w+)")?/gu)].map(([, , , list, lane]) => [list, lane ?? null]);
  for (const [list, lane] of links) assert.ok(list in states, `${list}${lane ? ' in ' + lane : ''} opens a known Items filter`);
  const bare = html.replace(/<button\b[\s\S]*?<\/button>/gu, '').replace(/<title>[\s\S]*?<\/title>|<svg\b[\s\S]*?<\/svg>/gu, '');
  for (const section of ['How work moved', 'Now', 'Your lanes']) {
    const start = bare.indexOf(`aria-label="${section}"`), body = bare.slice(start, bare.indexOf('</section>', start));
    assert.doesNotMatch(body.replace(/<th\b[\s\S]*?<\/th>|aria-label="[^"]*"|\d+ h\b|4 h/gu, ''), />\s*\d+\s*</u, `${section} has no count that opens nothing`);
  }

  // The flow cards, the Now line and the lane counts each narrow Items to the items they count.
  const card = step => new RegExp(`data-dashboard-step="${step}" data-dashboard-list="([\\w-]+)"`, 'u').exec(html)[1];
  assert.deepEqual(shown(card('build')), [4], 'Build opens the item being built');
  assert.deepEqual(shown(card('gate')), [5, 6], 'Gate opens the submitted items');
  assert.deepEqual(shown(card('land')), [8], 'Land opens the landed items');
  assert.deepEqual(shown('next'), [1, 2, 9], 'ready opens the ready items; sent back is a mark beside the stage, so #9 is in both');
  assert.deepEqual(shown('gated'), [3, 10], 'waiting opens the items waiting on others');
  assert.deepEqual(shown('passed'), [7], 'to land opens the accepted items');
  assert.deepEqual(shown('sent-back'), [9], 'sent back opens the items sent back to their builders');
  assert.match(html, /data-dashboard-list="review" data-dashboard-lane="tests"/u, 'a lane count carries its lane');
  assert.deepEqual(shown('review', 'tests'), [5], 'the tests lane review count opens that lane only');
  assert.equal(selectItemsView({ items, stateById, state: 'sent-back', lane: null }).filterLabel, 'Filter: Sent back', 'the Items filter names it');

  // Every item row and stage chip opens its own item.
  for (const id of [4, 5, 6, 7, 8]) assert.match(html, new RegExp(`data-go="item:${id}"`, 'u'), `#${id} opens its item`);
});

test('clause 2: the Agents notch opens the Dashboard at its Agents table [N26]', () => {
  assert.match(pageActions(), /else if \(to === 'agents'\) openTab\('dashboard', 'agents'\);/u, 'the notch opens #dashboard/agents');
  const html = dashboardHtml(dashboardModel(board().project, board().events, { now, complete: true }));
  assert.match(html, /<section class="dash-sec dash-agentsec" id="dashboard-agents" aria-label="Agents">/u, 'the address has a table to scroll to');
});
