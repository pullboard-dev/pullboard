/** #3021: the item row and the agent floor seat read a claim's stalled, waiting and handed-off state, never as building [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemStagePresentation } from '../../../src/logic/pipeline/model.js';
import { agentFloorHtml } from '../../../src/logic/agent/floor/render.js';
import { agentFloorModel } from '../../../src/logic/agent/floor/model.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { agentFloorData } from '../../fixtures/cockpit/floor.js';

const MINUTE = 60_000;

/** The floor input with a stalled claim (#7) and a waiting claim (#10) on two seats, as the board read carries them. */
function healthFloor() {
  const seeded = agentFloorData();
  const at = minutes => new Date(seeded.clockBase + minutes * MINUTE).toISOString();
  const project = structuredClone(seeded.input.project), events = structuredClone(seeded.input.events);
  project.items[6].claimHealth = { state: 'stalled', idleMinutes: 21, waitingOn: [], handoffRef: null };
  project.items.push({ id: 10, title: 'Waiting on the stalled one', lane: 'web', status: 'claimed', route: 'strong', updatedAt: at(-5),
    blockedBy: [], claim: { by: 'web-2', until: at(120) }, claimHealth: { state: 'waiting', idleMinutes: null, waitingOn: [7], handoffRef: null } });
  project.agents.push({ agent_id: 'web-2', agent_created_at: at(-240) });
  events.push({ event_id: events.length + 1, event_kind: 'claim', item_id: 10, event_by: 'web-2', event_at: at(-5), event_detail: JSON.stringify({ leaseUntil: at(120) }) });
  project.sequence = events.length;
  const floor = agentFloorModel(dashboardModel(project, events, { now: seeded.now, complete: true }), events);
  return { floor, html: agentFloorHtml(floor, { back: '/dashboard' }) };
}

test('view.x-io-dashboard-claim-health-rows.clause-1-an-item-row-reads-stalled: clause 1: an item row reads stalled with its idle minutes and waiting on its blockers [C7]', () => {
  const claimed = { status: 'claimed', claim: { by: 'web-1' } };
  const stalled = itemStagePresentation({ ...claimed, claimHealth: { state: 'stalled', idleMinutes: 21, waitingOn: [], handoffRef: null } });
  assert.deepEqual(stalled, { stage: 'Claimed', detail: 'stalled · 21 min' });
  const waiting = itemStagePresentation({ ...claimed, claimHealth: { state: 'waiting', idleMinutes: null, waitingOn: [7], handoffRef: null } });
  assert.deepEqual(waiting, { stage: 'Claimed', detail: 'waiting on #7' });
  const building = itemStagePresentation({ ...claimed, claimHealth: { state: 'building', idleMinutes: 2, waitingOn: [], handoffRef: null } });
  assert.deepEqual(building, { stage: 'Building', detail: 'by web-1' });
  assert.deepEqual(itemStagePresentation(claimed), building, 'a claim without health keeps reading Building');
});

test('view.x-io-dashboard-claim-health-rows.clause-1-the-agent-floor-seat-reads: clause 1: the agent floor seat reads stalled and waiting claims [C7]', () => {
  const { floor, html } = healthFloor();
  const seat = id => floor.groups.find(group => group.agents.some(agent => agent.id === id))?.key;
  assert.equal(seat('web-1'), 'stalled');
  assert.equal(seat('web-2'), 'stalled');
  assert.match(html, /#7 stalled · 21 min/u);
  assert.match(html, /#10 waiting on #7/u);
});

test('view.x-io-dashboard-claim-health-rows.clause-2-an-auto-released-item-reads: clause 2: an auto-released item reads handed off with its pin, and one never handed off does not [C7]', () => {
  const released = itemStagePresentation({ status: 'open', route: 'strong', claimHealth: { state: 'released', idleMinutes: null, waitingOn: [], handoffRef: 'view-9@4f2a1c' } });
  assert.deepEqual(released, { stage: 'Ready', detail: 'handed off · view-9@4f2a1c' });
  assert.deepEqual(itemStagePresentation({ status: 'open', route: 'strong' }), { stage: 'Ready', detail: 'strong route' });
});
