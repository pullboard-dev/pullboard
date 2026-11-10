/** The Agents drawer selects work from prepared observations and renders without browser or clock reads. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsPanelModel } from '../../../../src/logic/panel/model.js';
import { agentsPanelHtml } from '../../../../src/logic/panel/render.js';

const now = Date.parse('2026-10-28T12:00:00Z');
const agent = (agentId, lastMoveAt = null) => ({ agentId, name: agentId, nameHtml: agentId,
  faceHtml: '<span class="avatar">' + agentId + '</span>', tipHtml: 'tip ' + agentId,
  markClasses: ' h1', ageHtml: lastMoveAt ? '<time>recent</time>' : '', lastMoveAt });
const item = (id, values = {}) => ({ id, status: 'open', state: 'open', stale: false, titleTextHtml: 'item ' + id,
  titleHtml: '<b>item ' + id + '</b>', stateHtml: '<span class="chip">open</span>', briefStateHtml: '<span class="chip">open</span>', ...values });

test('Agents selection preserves holding rank, recent filtering, picked idle expansion and actions [N26]', () => {
  const agents = [agent('builder'), agent('reviewer'), agent('idle', new Date(now - 30 * 60_000).toISOString()), agent('quiet', new Date(now - 2 * 60 * 60_000).toISOString())];
  const items = [
    item(1, { status: 'claimed', state: 'building', holder: 'builder' }),
    item(2, { status: 'submitted', state: 'verify', builtBy: 'builder', reviewer: 'reviewer' }),
    item(3, { state: 'back', builtBy: 'builder', stale: true }),
  ];
  const original = structuredClone({ agents, items });
  const panel = agentsPanelModel({ agents, items, now, activeAgent: 'idle', allAgents: false, idleOpen: false });
  assert.deepEqual(panel.busy.find(row => row.agentId === 'builder').holding.map(row => row.id), [1, 3, 2],
    'claimed work remains first, then sent-back or stale work, then other held work');
  assert.equal(panel.busy.find(row => row.agentId === 'reviewer').holding[0].id, 2);
  assert.ok(panel.idle.some(row => row.agentId === 'idle'), 'a recently active agent with no work stays in the recent list');
  assert.ok(!panel.listed.some(row => row.agentId === 'quiet'), 'an old idle agent stays out of the default list');
  const invalidClock = agentsPanelModel({ agents: [agent('future', new Date(now + 365 * 24 * 60 * 60_000).toISOString())], items: [], now: Infinity });
  assert.equal(invalidClock.listed.length, 0, 'non-finite now never admits an idle agent by recency');
  assert.equal(panel.idleOpen, true, 'picking an idle agent opens its fold');
  assert.equal(panel.showAll, true);
  assert.deepEqual({ agents, items }, original, 'selection does not mutate the board observations');
  const html = agentsPanelHtml(panel);
  assert.match(html, /data-agent="builder"/u);
  const expanded = agentsPanelModel({ agents, items, now, activeAgent: 'builder' });
  assert.match(agentsPanelHtml(expanded), /data-go="item:1"/u);
  assert.match(html, /data-agent="idle"/u);
  assert.match(html, /<button class="fold-line" data-fold="idle" type="button" aria-expanded="true" title="idle"><span>1 idle<\/span><span class="fold-more">hide<\/span><\/button>/u,
    'idle fold markup remains byte-for-byte compatible with the existing foldLine helper');
  assert.match(html, /show all 4/u);
  const all = agentsPanelModel({ agents, items, now, allAgents: true });
  assert.equal(all.listed.length, 4);
  assert.doesNotMatch(agentsPanelHtml(all), /show only agents at work/u,
    'the show-only choice remains inside the idle fold when idle agents exist');
  const allOpen = agentsPanelModel({ agents, items, now, allAgents: true, idleOpen: true });
  assert.match(agentsPanelHtml(allOpen), /show only agents at work/u);
});


test('compact Agents entries keep model and state columns without avatars or bare extra-item counts [N26]', () => {
  const builder = { ...agent('builder'), modelHtml: 'GPT-6.1 Sol' };
  const panel = agentsPanelModel({ agents: [builder], now, items: [
    item(1, { status: 'claimed', holder: 'builder', ageHtml: '<time>23m</time>' }),
    item(2, { status: 'submitted', state: 'verify', builtBy: 'builder' }),
  ] });
  const html = agentsPanelHtml(panel);
  assert.match(html, /class="agent-who"><b>builder<\/b><span class="agent-model">GPT-6.1 Sol<\/span>/u);
  assert.match(html, /class="agent-state"><time>23m<\/time>/u);
  assert.match(html, /title="tip builder · \+1 more item"/u);
  assert.doesNotMatch(html, /avatar|class="agent-more"/u);
});
