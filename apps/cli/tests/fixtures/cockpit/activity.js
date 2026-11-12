/** Deterministic Activity render input without a board, browser, process, or network [N26,C7]. */
export const now = Date.parse('2026-10-28T04:12:00Z');
/** Convert a fixed offset into input data without reading the current clock. */
export const at = minutes => new Date(now - minutes * 60_000).toISOString();
export const items = [{ id: 1, title: 'First <item> with a deliberately long title to ellipsize' }, { id: 2, title: 'Second item' }];
export const agents = [{ agent_id: 'view-1', model: 'Test Model' }];
/** Build an event-shaped data record; no board move or operational receipt is implied. */
export const event = (id, kind, { item = 1, by = 'view-1', minutes = id, detail = {} } = {}) => ({ event_id: id, event_kind: kind, item_id: item, event_by: by, event_at: at(minutes), event_detail: JSON.stringify(detail) });


/** Plain event-shaped input mirrors a health scan; it is not evidence of a native move or receipt. */
export function scannedBoard() {
  const finding = { key: 'RANK_INVERSION:item:1', cause: 'RANK_INVERSION', item: 1, subject: '#1', title: 'a free item ranks ahead', since: at(11),
    why: 'view-1 claimed #1 while #2 ranks ahead in the view lane and sits free', owner: 'view-1', next: 'release #1, then claim #2' };
  const notice = `Stuck: #1 a free item ranks ahead [RANK_INVERSION], since ${finding.since}. ${finding.why}. Owner: view-1. Next: ${finding.next}.`;
  const shouts = [{ shout_id: 1, shout_from: 'sentinel', shout_to: 'view-1', shout_text: notice }, { shout_id: 2, shout_from: 'sentinel', shout_to: 'coordinator', shout_text: notice },
    { shout_id: 3, shout_from: 'sentinel', shout_to: 'coordinator', shout_text: 'Health: 8 more notices from this run were held back, so one run never floods a feed; pullboard health lists every finding.' },
    { shout_id: 4, shout_from: 'view-1', shout_to: 'coordinator', shout_text: 'Keep [MY_CODE] and <these words>.\nNext appointment: 2026-10-28T04:12:00Z' }];
  const events = [event(1, 'shout', { by: 'sentinel', item: null, detail: { shout: 1 } }), event(2, 'shout', { by: 'sentinel', item: null, detail: { shout: 2 } }),
    event(3, 'health-failure', { by: 'sentinel', detail: { key: finding.key, cause: 'refusal:RANK_INVERSION', since: finding.since, subject: '#1' } }),
    event(4, 'shout', { by: 'sentinel', item: null, detail: { shout: 3 } }), event(5, 'health-scan', { by: 'coordinator', item: null, detail: { active: [finding] } }),
    event(6, 'shout', { item: null, detail: { shout: 4 } }), event(7, 'activity-delivered', { item: null }), event(8, 'flake-observation', { item: null })];
  return { items, agents, shouts, events, finding };
}
