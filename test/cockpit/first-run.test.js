/** First-run shows only until the loop is proven running, and recognises an existing coordinator [N26,N38]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstRunKit } from '../../apps/view/index.js';

const kit = firstRunKit();
const established = {
  agents: [{ agent_id: 'coordinator', agent_lane: 'coordinator', model: 'gpt-6' }, { agent_id: 'tests-1', agent_lane: 'tests', model: 'unknown' }],
  spec: [{ id: 'G1', status: 'approved' }],
  dashboardLanded: Array.from({ length: 1700 }, (_, at) => ({ id: at })),
};

test('an established board with a coordinator and landed items shows no first-run [N26,N38]', () => {
  const state = kit.model(established, []);
  assert.equal(state.ticks[0], true, 'a coordinator that identified itself before first-run existed is recognised');
  assert.equal(kit.visible(state, false), false, 'the loop is proven, so first-run is gone');
});

test('a new board shows first-run with the right ticks [N26,N38]', () => {
  const fresh = kit.model({ agents: [{ agent_id: 'coordinator', agent_lane: 'coordinator', model: null }] }, []);
  assert.deepEqual(fresh.ticks, [false, false, false, false, false, false, false], 'the init placeholder is not a running coordinator');
  assert.equal(kit.visible(fresh, false), true);
  assert.match(kit.html(fresh), /Create your Coordinator Agent/u);
});

test('the checklist completes once the coordinator joins and an item lands, and the page then goes [N26,N38]', () => {
  const placeholder = { agents: [{ agent_id: 'coordinator', agent_lane: 'coordinator' }] };
  const landed = [{ event_kind: 'merged' }];
  assert.equal(kit.visible(kit.model(placeholder, landed), false), true, 'an item landed but no coordinator has joined');
  const joined = { agents: [{ agent_id: 'coordinator-1', agent_lane: 'coordinator' }] };
  assert.equal(kit.model(joined, []).ticks[0], true, 'the coordinator joins');
  assert.equal(kit.visible(kit.model(joined, []), false), true, 'a coordinator alone has not proven the loop');
  assert.equal(kit.visible(kit.model(joined, landed), false), false, 'a coordinator and a landed item prove the loop');
});
