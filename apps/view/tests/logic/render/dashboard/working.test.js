/** Every count of agents at work on screen reads one list: the notch's, passed to the Dashboard [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cockpitSidebar } from '../../../../index.js';
import { pageScriptPart2 } from '../../../../index.js';
import { dashboardModel } from '../../../../src/io/dashboard/model.js';
import { dashboardHtml } from '../../../../src/logic/render/dashboard.js';

const now = Date.parse('2026-11-13T04:00:00Z');
const minutes = n => new Date(now - n * 60_000).toISOString();
/** A board with one builder, one reviewer, one agent that moved ten minutes ago and one that moved three hours ago. */
const project = {
  sequence: 9, agents: [
    { agent_id: 'builder-1', lastMoveAt: minutes(2) }, { agent_id: 'reviewer-1', lastMoveAt: minutes(5) },
    { agent_id: 'recent-1', lastMoveAt: minutes(10) }, { agent_id: 'idle-1', lastMoveAt: minutes(180) },
  ],
  items: [
    { id: 1, status: 'claimed', owner: 'builder-1', claim: { by: 'builder-1', until: new Date(now + 600_000).toISOString() } },
    { id: 2, status: 'submitted', reviewer: 'reviewer-1', reviewUntil: new Date(now + 600_000).toISOString(), claim: { by: 'someone-else' } },
  ],
};
/** What the hero says and what the Agents card's heading says, as drawn. */
const shown = model => {
  const html = dashboardHtml(model);
  return { hero: /(\d+) agents? at work\./u.exec(html)?.[1], heading: /(\d+) working/u.exec(html)?.[1] };
};

test('clause 1: the Dashboard hero and the Agents heading count the list the notch counts [N26]', () => {
  // Alone, the model reads its own list: both holders and the agent that moved ten minutes ago.
  const own = dashboardModel(project, [], { now, complete: false });
  assert.deepEqual(shown(own), { hero: '3', heading: '3' });
  // Given the notch's list, the hero, the heading and the groups all follow it, whatever the model would have counted.
  const given = dashboardModel(project, [], { now, complete: false, working: ['builder-1', 'idle-1'] });
  assert.equal(given.totals.working, 2);
  assert.deepEqual(shown(given), { hero: '2', heading: '2' });
  assert.deepEqual(Object.fromEntries(given.agents.map(agent => [agent.id, agent.group])),
    { 'builder-1': 'building', 'reviewer-1': 'quiet', 'recent-1': 'quiet', 'idle-1': 'between items' });
  const none = dashboardModel(project, [], { now, complete: false, working: [] });
  assert.equal(none.totals.working, 0);
});

test('clause 1: the page hands the Dashboard the notch\'s list, from the same memoised nav numbers [N26]', () => {
  const sidebar = cockpitSidebar(new Proxy({}, { get: () => function stub() { return {}; } }));
  assert.match(sidebar, /return \{ agents: busy\.length, agentIds: busy\.map\(\(a\) => a\.agent_id\),/u, 'the nav numbers carry the ids behind the notch count');
  assert.match(sidebar, /drawNav\(shown, store\.select\('nav-numbers', \[shown, view\.allAgents, Math\.floor\(Date\.now\(\) \/ 60_000\)\], navNumbers\)\)/u, 'the notch draws from them');
  const script = pageScriptPart2(new Proxy({}, { get: () => function stub() { return {}; } }));
  assert.match(script, /working: project => store\.select\('nav-numbers', \[project, view\.allAgents, Math\.floor\(Date\.now\(\) \/ 60_000\)\], navNumbers\)\.agentIds/u, 'the Dashboard reads the same selection');
});
