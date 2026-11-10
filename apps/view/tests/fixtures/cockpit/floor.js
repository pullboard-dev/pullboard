/** Deterministic plain summary/history input, never a native receipt or operational proof [N26]. */
export function agentFloorData() {
  const MINUTE = 60_000, clockBase = Date.parse('2026-10-28T12:00:00.000Z');
  const at = minutes => new Date(clockBase + minutes * MINUTE).toISOString();
  const titles = ['Landed one', 'Landed two', 'Accepted, waiting to land', 'In review with a reviewer',
    'In review, nobody yet', 'Sent back once', 'Ready one', 'Ready two', 'Ready three'];
  const items = titles.map((title, index) => ({ id: index + 1, title, lane: 'web', status: 'open',
    route: 'strong', updatedAt: at(-60), blockedBy: [] }));
  const events = [];
  /** Append event-shaped input so production models, not a test model, derive every displayed number. */
  const event = (kind, id, by, minutes, detail = {}) => events.push({ event_id: events.length + 1,
    event_kind: kind, item_id: id, event_by: by, event_at: at(minutes), event_detail: JSON.stringify(detail) });
  for (const item of items) event('add', item.id, 'coordinator', -60);
  const sequences = [[1, -50, -45, -40, -39], [2, -38, -33, -30, -29], [3, -28, -25, -24],
    [4, -23, -20], [5, -19, -16], [6, -15, -12]];
  const dashboardLanded = [];
  for (const [id, claim, submit, accept, merged] of sequences) {
    event('claim', id, 'web-1', claim, { leaseUntil: at(120) });
    event('submit', id, 'web-1', submit);
    items[id - 1].status = 'submitted';
    if (accept !== undefined) { event('accept', id, 'coordinator', accept); items[id - 1].status = 'verified'; }
    if (merged !== undefined) {
      const commit = id.toString(16).padStart(40, '0');
      event('merged', id, 'coordinator', merged, { commit });
      dashboardLanded.push({ id, commit });
    }
  }
  event('reject', 6, 'tests-1', -10);
  items[5].status = 'open';
  items[5].verdict = { decision: 'REJECT', by: 'tests-1' };
  event('reserve', 4, 'tests-1', -9, { until: at(180) });
  items[3].claim = { by: 'tests-1', until: at(180) };
  event('claim', 7, 'web-1', -8, { leaseUntil: at(120) });
  items[6].status = 'claimed';
  items[6].claim = { by: 'web-1', until: at(120) };
  for (const id of ['quiet-1', 'quiet-2']) event('join', null, id, 0, { lane: 'quiet' });
  event('shout', null, 'quiet-1', 10, { to: 'all', text: 'Between items on the floor.' });
  const agents = ['web-1', 'tests-1', 'quiet-1', 'quiet-2'].map(id => ({ agent_id: id,
    model: 'Floor input ' + id, agent_created_at: at(id.startsWith('quiet') ? 0 : -240) }));
  const project = { root: '/plain-agent-floor-input', sequence: events.length, items, agents,
    events: events.slice(-80), holds: [], itemHolds: [], dashboardLanded,
    dashboardNext: [6, 8, 9], dashboardPace: { last24h: 2, last6h: 2, last2h: 2 } };
  return { clockBase, now: clockBase + 25 * MINUTE, input: { project, events }, held: items[6] };
}
