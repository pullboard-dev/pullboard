/** Live headline checks: peak concurrent agents from claim and reservation events, and the floor's sentence [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { cockpitLive } from '../../../index.js';
import { agentFloorHtml } from '../../../src/logic/agent/floor/render.js';
import { agentFloorModel } from '../../../src/logic/agent/floor/model.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';

const MINUTE = 60_000;
const base = Date.parse('2026-11-04T12:00:00.000Z');
/** The ISO time a number of minutes from the fixture's base moment. */
const at = minutes => new Date(base + minutes * MINUTE).toISOString();

/** Event-shaped input, so the production projection derives every number, as the page does. */
function fixture(agents, rows) {
  const events = rows.map(([kind, id, by, minutes, detail = {}], index) => ({ event_id: index + 1, event_kind: kind,
    item_id: id, event_by: by, event_at: at(minutes), event_detail: JSON.stringify(detail) }));
  const project = { root: '/live-headline-input', sequence: events.length, items: [], agents: agents.map(agent_id => ({ agent_id })),
    events, holds: [], itemHolds: [], dashboardLanded: [] };
  return { project, events };
}

test('view.cockpit-live.peak-agents-counts-the-most-agents-holding: peak agents counts the most agents holding a claim or a review at one moment [N26]', () => {
  // Three overlapping claims and one review all open at minute -5: four different agents.
  const { project, events } = fixture(['a', 'b', 'c', 'd'], [
    ['claim', 1, 'a', -30, { leaseUntil: at(120) }],
    ['claim', 2, 'b', -20, { leaseUntil: at(120) }],
    ['claim', 3, 'c', -10, { leaseUntil: at(120) }],
    ['reserve', 4, 'd', -5, { until: at(120) }],
  ]);
  const model = dashboardModel(project, events, { now: base, complete: true });
  assert.equal(model.peak, 4, 'four agents hold work at once');
});

test('view.cockpit-live.an-agent-holding-a-claim-and-a: an agent holding a claim and a review at once counts once [N26]', () => {
  const { project, events } = fixture(['a'], [
    ['claim', 1, 'a', -30, { leaseUntil: at(120) }],
    ['reserve', 2, 'a', -29, { until: at(120) }],
  ]);
  assert.equal(dashboardModel(project, events, { now: base, complete: true }).peak, 1);
});

test('view.cockpit-live.holds-older-than-the-last-24-hours: holds older than the last 24 hours do not count toward the peak [N26]', () => {
  // The stale claim expired 29 hours ago, so only the open claim of agent b is in the window.
  const { project, events } = fixture(['a', 'b'], [
    ['claim', 1, 'a', -1800, { leaseUntil: at(-1740) }],
    ['claim', 2, 'b', -10, { leaseUntil: at(120) }],
  ]);
  assert.equal(dashboardModel(project, events, { now: base, complete: true }).peak, 1);
});

test('view.cockpit-live.the-headline-reads-n-landed-in-24: the headline reads N landed in 24 hours, then X peak agents, from the board [N26]', () => {
  const { project, events } = fixture(['a', 'b', 'c', 'd'], [
    ['claim', 1, 'a', -30, { leaseUntil: at(120) }],
    ['claim', 2, 'b', -20, { leaseUntil: at(120) }],
    ['claim', 3, 'c', -10, { leaseUntil: at(120) }],
    ['reserve', 4, 'd', -5, { until: at(120) }],
  ]);
  const model = dashboardModel(project, events, { now: base, complete: true });
  const html = agentFloorHtml(agentFloorModel(model, events), { back: '/dashboard' });
  assert.match(html, /<h1><em>0 landed in 24 hours\.<\/em> 4 peak agents\.<\/h1>/u);
});

test('view.cockpit-live.an-incomplete-history-shows-the-peak-as: an incomplete history shows the peak as a dash, never as zero [N26]', () => {
  const { project, events } = fixture(['a'], [['claim', 1, 'a', -30, { leaseUntil: at(120) }]]);
  const model = dashboardModel(project, events, { now: base, complete: false });
  assert.equal(model.peak, null);
  const html = agentFloorHtml(agentFloorModel(model, events), { back: '/dashboard' });
  assert.match(html, /<h1><em>[^<]*landed in 24 hours\.<\/em> — peak agents\.<\/h1>/u);
});

/** The generated page's stream listener and status line, run as the page runs them, against one fetch answer. */
async function listenAfter(status, { localSession = null, localReadBase = '' } = {}) {
  const live = cockpitLive({ pageScriptPart1: () => '', pageScope: {}, pageScriptPart2: () => '', pageScriptPart3: () => '' });
  const from = live.indexOf('function liveLine()');
  const to = live.indexOf('/** Stop following', from);
  const listenFrom = live.indexOf('async function listen(entry)');
  const listenTo = live.indexOf('/**', listenFrom);
  assert.ok(from >= 0 && to > from && listenFrom >= 0 && listenTo > listenFrom, 'the generated page contains its status line and its stream listener');
  const text = { live: '' };
  const calls = { expired: 0, timers: 0 };
  const entry = { boards: [{ id: 'b', root: '/r', shown: 0 }], cursor: '', status: 'up', offline: false, failures: 0 };
  const context = {
    stateWorkerStopped: false, FALLBACK_MS: 30000, localSession, localReadBase, localReadHeaders: {}, stream: entry, entry,
    canStream: () => true, AbortController, TypeError, encodeURIComponent, setTimeout: () => { calls.timers += 1; return 1; },
    fetch: async () => ({ status, ok: false, body: null }), localExpired: () => { calls.expired += 1; },
    $: () => text, streamRefusal: () => '', catchRoots: new Set(), catchUp: () => {},
  };
  const page = runInNewContext(live.slice(from, to) + live.slice(listenFrom, listenTo) + '; ({ listen, liveLine })', context);
  await page.listen(entry);
  return { line: text.live, calls, entry };
}

test('view.cockpit-live.refused-shows-link-line: a local view that refuses its own page stops retrying and shows one plain open-the-link-again line [N26]', async () => {
  for (const status of [401, 403]) {
    const { line, calls, entry } = await listenAfter(status);
    assert.equal(line, 'this view refused the page: open the link pullboard view printed again');
    assert.equal(calls.timers, 0, 'no retry is queued');
    assert.equal(calls.expired, 0, 'the hosted path is not taken');
    assert.equal(entry.refused, true);
  }
});

test('view.cockpit-live.hosted-refusal-unchanged: a hosted page with a local session still goes round again and shows no refusal line [N26]', async () => {
  const origin = 'http://127.0.0.1:1';
  const { line, calls } = await listenAfter(403, { localSession: { origin }, localReadBase: origin });
  assert.equal(calls.expired, 1, 'the hosted page asks for a new session');
  assert.equal(calls.timers, 0);
  assert.equal(line, '');
});
