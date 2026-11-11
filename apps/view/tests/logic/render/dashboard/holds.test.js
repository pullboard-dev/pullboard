/** Dashboard counts for live public claim and review leases [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';

test('the dashboard counts three live builders and one reviewer from public lease fields [N26]', () => {
  const now = Date.parse('2026-11-03T18:00:00Z');
  const until = new Date(now + 30 * 60_000).toISOString();
  const project = {
    items: [
      // A submission waiting for its gate remains claimed, with its active lease in the public summary.
      { id: 1, title: 'Gate-queued submit', status: 'claimed', claim: { by: 'core-1', until } },
      // Some public snapshots carry the builder in owner when claim.by is absent.
      { id: 2, title: 'Owner fallback', status: 'claimed', owner: 'core-2', claim: { until } },
      { id: 3, title: 'Claim holder', status: 'claimed', claim: { by: 'core-3', until } },
      { id: 4, title: 'Reserved review', status: 'submitted', reviewer: 'tests-1', reviewUntil: until, claim: { until } },
    ],
    agents: ['core-1', 'core-2', 'core-3', 'tests-1'].map(agent_id => ({ agent_id })),
    sequence: 0,
  };

  const model = dashboardModel(project, [], { now });
  assert.deepEqual(model.claims.map(item => item.id), [1, 2, 3], 'the three live claim holders include missing claim.by with owner fallback');
  assert.equal(model.agents.filter(agent => agent.group === 'building').length, 3);
  assert.equal(model.agents.filter(agent => agent.group === 'reviewing').length, 1, 'the active reservation counts its reviewer');
  const html = dashboardHtml(model);
  assert.match(html, /data-dashboard-stat="building" data-value="3">3 building/);
  assert.match(html, /dash-agent-group label">BUILDING · 3/);
  assert.match(html, /dash-agent-group label">REVIEWING · 1/);
});
