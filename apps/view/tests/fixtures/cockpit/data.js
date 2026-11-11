/** Plain deterministic render inputs, not native receipts, proofs, or authenticated board observations [N26]. */
export const DASHBOARD_NOW = Date.parse('2026-10-28T12:00:00.000Z');

/** Construct independent summary objects and event-shaped data for one pure model invocation. */
export function dashboardData({ populated = false } = {}) {
  const base = DASHBOARD_NOW, minute = 60_000, hour = 60 * minute;
  const iso = offset => new Date(base + offset).toISOString();
  const events = [];
  /** Add input data in native wire shape without invoking a board or asserting operational evidence. */
  const event = (kind, item, by, offset, detail = {}) => events.push({ event_id: events.length + 1,
    event_kind: kind, item_id: item, event_by: by, event_at: iso(offset), event_detail: JSON.stringify(detail) });
  const names = populated ? ['Landed 1', 'Landed 2', 'Landed 3', 'Accepted, waiting to land',
    ...Array.from({ length: 6 }, (_, i) => 'In review ' + (i + 1)),
    ...Array.from({ length: 10 }, (_, i) => 'Ready ' + (i + 1)), 'Current builder']
    : ['Live builder', 'Merged work', 'Reserved review', 'Held open', 'First open', 'Second open'];
  const items = names.map((title, i) => ({ id: i + 1, title, lane: 'web', status: 'open',
    route: 'strong', updatedAt: iso(-10 * minute), blockedBy: [] }));
  const agents = [{ agent_id: 'web-1', model: 'Dashboard builder', agent_created_at: iso(-hour) },
    { agent_id: 'tests-1', model: 'Dashboard reviewer', agent_created_at: iso(-hour) }];
  const landedIds = populated ? [1, 2, 3] : [2], acceptedIds = populated ? [4] : [];
  const reviewIds = populated ? [5, 6, 7, 8, 9, 10] : [3], builderId = populated ? 21 : 1;
  const dashboardLanded = [];
  for (const id of [...landedIds, ...acceptedIds, ...reviewIds]) {
    const item = items[id - 1];
    event('claim', id, 'web-1', -15 * minute, { leaseUntil: iso(2 * hour) });
    event('submit', id, 'web-1', -12 * minute);
    item.status = 'submitted';
    item.builtBy = 'web-1';
    if (landedIds.includes(id) || acceptedIds.includes(id)) {
      event('accept', id, 'coordinator', -10 * minute);
      item.status = 'verified';
    }
    if (landedIds.includes(id)) {
      const commit = id.toString(16).padStart(40, '0');
      event('merged', id, 'coordinator', -minute, { commit });
      dashboardLanded.push({ id, commit });
    }
  }
  items[builderId - 1].status = 'claimed';
  items[builderId - 1].claim = { by: 'web-1', until: iso(2 * hour) };
  event('claim', builderId, 'web-1', -3 * minute, { leaseUntil: iso(hour) });
  event('renew', builderId, 'web-1', -2 * minute, { leaseUntil: iso(2 * hour) });
  const reviewerId = reviewIds[0], reviewUntil = iso(populated ? 3 * hour : hour);
  items[reviewerId - 1].claim = { by: 'tests-1', until: reviewUntil };
  event('reserve', reviewerId, 'tests-1', -minute, { until: reviewUntil });
  if (populated) {
    for (const id of ['quiet-1', 'quiet-2']) {
      agents.push({ agent_id: id, model: 'Quiet input ' + id, agent_created_at: iso(0) });
      event('join', null, id, 0, { lane: 'quiet' });
    }
    event('shout', null, 'quiet-1', 2 * minute, { to: 'person', text: 'Recent activity input.' });
    event('shout', null, 'sentinel', 2 * minute, { to: 'person', text: 'Health input, not an agent.' });
  } else {
    event('shout', null, 'coordinator', -5 * hour, { to: 'person' });
    for (let n = 0; n < 85; n++) event('shout', null, 'coordinator', 0, { to: 'person', text: 'Input shout ' + n });
    event('shout', null, 'coordinator', 5 * hour, { to: 'person' });
  }
  const pace = { last2h: landedIds.length, last6h: landedIds.length, last24h: landedIds.length };
  const summary = { total: items.length, left: items.length - landedIds.length, landed: landedIds.length,
    landing: acceptedIds.length, review: reviewIds.length, building: 1,
    waiting: populated ? 10 : 2, held: populated ? 0 : 1,
    pace, estimate: { low: 2, high: 4 }, window: '6h' };
  const project = { root: '/plain-dashboard-input', sequence: events.length, items, agents,
    events: events.slice(-80), dashboardNext: items.map(item => item.id).reverse(), dashboardLanded,
    itemHolds: populated ? [] : [{ item: 4 }], holds: [], milestones: [{ name: '0.1.0',
      items: items.map(item => ({ id: item.id })), summary }] };
  return { project, events, now: base + 1000, clockBase: base, mergeCommit: dashboardLanded[0].commit };
}

/** Return fresh after-release data, preserving the original plain input and its ordered prefix. */
export function releasedDashboardData(input) {
  const next = structuredClone(input);
  const event = { event_id: next.events.length + 1, event_kind: 'release', item_id: 3, event_by: 'tests-1',
    event_at: new Date(DASHBOARD_NOW + 60_000).toISOString(), event_detail: JSON.stringify({ review: true }) };
  next.events.push(event);
  delete next.project.items.find(item => item.id === 3).claim;
  next.project.sequence = event.event_id;
  next.project.events = next.events.slice(-80);
  next.now = DASHBOARD_NOW + 61_000;
  return next;
}
