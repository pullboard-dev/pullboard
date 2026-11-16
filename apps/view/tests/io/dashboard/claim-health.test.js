/** @pullboard-test-input source-cell apps/view */
/** #6477: the Dashboard counts stalled and waiting claims apart from building [C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { agentFloorModel } from '../../../src/logic/agent/floor/model.js';

const now = Date.parse('2026-11-15T18:00:00Z'), minute = 60_000;
const until = new Date(now + 30 * minute).toISOString();
const at = ago => new Date(now - ago * minute).toISOString();

/** One board read: a building claim, a stalled claim, a waiting claim, each with its own seat. */
function board() {
  const claim = (id, by, health) => ({ id, title: 'Item ' + id, status: 'claimed', lane: 'view', claim: { by, until }, updatedAt: at(5), claimHealth: health });
  const items = [
    claim(1, 'view-1', { state: 'building', idleMinutes: 2, waitingOn: [], handoffRef: null }),
    claim(2, 'view-2', { state: 'stalled', idleMinutes: 25, waitingOn: [], handoffRef: null }),
    claim(3, 'view-3', { state: 'waiting', idleMinutes: null, waitingOn: [2], handoffRef: null }),
  ];
  const events = items.map((item, index) => ({ event_id: index + 1, event_kind: 'claim', item_id: item.id, event_by: item.claim.by,
    event_at: at(30), event_detail: JSON.stringify({ leaseUntil: until }) }));
  const project = { items, events, sequence: events.length, agents: items.map(item => ({ agent_id: item.claim.by })), milestones: [] };
  return dashboardModel(project, events, { now, complete: true });
}

test('clause 1: the building count leaves out the stalled and waiting claims and shows stalled 1 and waiting 1 [C7,N26]', () => {
  const model = board();
  assert.equal(model.stages.building, 1, 'only the claim that is building counts as building');
  assert.equal(model.stages.stalled, 1);
  assert.equal(model.stages.waitingClaims, 1);
  assert.equal(model.lanes.find(row => row.lane === 'view').building, 1, 'the lane row agrees');
  const html = dashboardHtml(model);
  assert.match(html, /<b>1<\/b>building/u);
  assert.match(html, /<b>1<\/b>stalled/u);
  assert.match(html, /<b>1<\/b>waiting/u);
});

test('clause 1: a board with no stalled or waiting claim shows no such tiles [C7,N26]', () => {
  const model = board();
  const plain = { ...model, stages: { ...model.stages, stalled: 0, waitingClaims: 0 } };
  const html = dashboardHtml(plain);
  assert.doesNotMatch(html, /<\/b>stalled/u);
  assert.doesNotMatch(html, /<\/b>waiting/u);
});

test('clause 3: neither the dashboard nor the agent floor counts the stalled claim as building [C7]', () => {
  const model = board();
  const floor = agentFloorModel(model, []);
  const keyOf = id => floor.groups.find(group => group.agents.some(agent => agent.id === id))?.key;
  assert.equal(keyOf('view-1'), 'building');
  assert.equal(keyOf('view-2'), 'stalled', 'the stalled claim sits apart from building');
  assert.equal(keyOf('view-3'), 'stalled', 'the waiting claim sits apart from building');
  assert.equal(floor.numbers.building, 1);
  assert.equal(model.stages.building, 1);
});
