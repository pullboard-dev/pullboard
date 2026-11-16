/** A small board for the /live-style Dashboard tests (#6847): every stage occupied, one release, history inside and outside four hours [N26]. */
export const now = Date.parse('2026-11-12T18:00:00Z');
const at = minutes => new Date(now - minutes * 60_000).toISOString();
const until = new Date(now + 30 * 60_000).toISOString();

/** The board's items, its event history and its project read, all plain input. */
export function board() {
  const items = [
    { id: 1, title: 'Ready one', status: 'open', lane: 'web', updatedAt: at(5) },
    { id: 2, title: 'Ready two', status: 'open', lane: 'web', updatedAt: at(5) },
    { id: 3, title: 'Waits on 1', status: 'open', lane: 'web', blockedBy: [1], updatedAt: at(5) },
    { id: 4, title: 'Being built', status: 'claimed', lane: 'web', claim: { by: 'web-1', until }, updatedAt: at(5) },
    { id: 5, title: 'Reviewed now', status: 'submitted', lane: 'tests', reviewer: 'tests-1', reviewUntil: until, updatedAt: at(5) },
    { id: 6, title: 'In the gate', status: 'submitted', lane: 'web', updatedAt: at(5) },
    { id: 7, title: 'Passed', status: 'verified', lane: 'web', updatedAt: at(5) },
    { id: 8, title: 'Landed', status: 'verified', lane: 'web', merged: true, updatedAt: at(5) },
    { id: 9, title: 'Sent back', status: 'open', lane: 'web', verdict: { decision: 'REJECT' }, updatedAt: at(5) },
    { id: 10, title: 'Held', status: 'open', lane: 'web', updatedAt: at(5) },
  ];
  const detail = value => JSON.stringify(value);
  const events = [
    { event_kind: 'reject', item_id: 6, event_by: 'tests-1', event_at: at(300), event_detail: '{}' },
    { event_kind: 'join', item_id: null, event_by: 'web-1', event_at: at(200), event_detail: detail({ lane: 'web' }) },
    { event_kind: 'join', item_id: null, event_by: 'tests-1', event_at: at(200), event_detail: detail({ lane: 'tests' }) },
    { event_kind: 'claim', item_id: 6, event_by: 'web-1', event_at: at(120), event_detail: detail({ leaseUntil: until }) },
    { event_kind: 'submit', item_id: 6, event_by: 'web-1', event_at: at(100), event_detail: '{}' },
    { event_kind: 'claim', item_id: 5, event_by: 'web-1', event_at: at(98), event_detail: detail({ leaseUntil: until }) },
    { event_kind: 'reject', item_id: 9, event_by: 'tests-1', event_at: at(90), event_detail: '{}' },
    { event_kind: 'submit', item_id: 5, event_by: 'web-1', event_at: at(70), event_detail: '{}' },
    { event_kind: 'proof-run', item_id: 5, event_by: 'web-1', event_at: at(65), event_detail: detail({ receipt: { kind: 'submit', exitCode: 0 } }) },
    { event_kind: 'gate-run', item_id: 2, event_by: 'web-1', event_at: at(64), event_detail: detail({ run: { green: false } }) },
    { event_kind: 'merged', item_id: 8, event_by: 'coordinator', event_at: at(60), event_detail: detail({ commit: 'c'.repeat(40) }) },
    { event_kind: 'claim', item_id: 4, event_by: 'web-1', event_at: at(40), event_detail: detail({ leaseUntil: until }) },
    { event_kind: 'reserve', item_id: 5, event_by: 'tests-1', event_at: at(20), event_detail: detail({ until }) },
  ].map((event, index) => ({ event_id: index + 1, ...event }));
  const summary = { total: 10, left: 9, landed: 1, landing: 1, review: 2, building: 1, waiting: 4, held: 1, pace: { last6h: 6, last2h: 2, last24h: 1 } };
  const project = { items, events, sequence: events.length, lanes: ['coordinator', 'web', 'tests'],
    agents: [{ agent_id: 'web-1' }, { agent_id: 'tests-1' }], itemHolds: [{ item: 10 }],
    dashboardLanded: [{ id: 8, commit: 'c'.repeat(40) }], dashboardNext: [2, 1],
    milestones: [{ name: '0.1.0: First release', summary, items: items.map(item => ({ id: item.id })) }],
    dashboardRunners: { runners: [{ runner: 1, busy: true, cpu: 40, ram: 50, jobs: [{ kind: 'gate', item: 6 }] }, { runner: 2, busy: false, cpu: 5, ram: 20, jobs: [] }],
      runs: [{ kind: 'gate', item: 6, items: [6], runners: [1] }] } };
  return { project, events, items };
}
