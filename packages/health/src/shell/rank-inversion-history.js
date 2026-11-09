/** Qualify advisory queue inversions against recorded claim-time history [N2,B13]. */

const FREE = new Set(['add', 'release', 'reopen', 'lapse', 'reject']);
const MOVES = new Set([...FREE, 'claim', 'renew', 'submit', 'accept', 'withdraw', 'reject']);

/** Read ordering evidence once; event ids distinguish moves recorded at the same clock time. */
export function rankInversionHistory(board) {
  // Two index ranges, not an OR with LIKE, which made SQLite scan every event [C7].
  const events = board.db.prepare(`SELECT event_id, event_at, event_kind, event_by, item_id, event_detail
    FROM event WHERE event_kind IN ('add','release','reopen','lapse','claim','renew','submit','accept','withdraw','reject','hold_item','unhold_item')
    UNION ALL SELECT event_id, event_at, event_kind, event_by, item_id, event_detail
    FROM event WHERE event_kind > 'milestone' AND event_kind < 'milestonf' AND event_kind LIKE 'milestone_%' ORDER BY event_id`).all();
  const details = new Map();
  const byItem = new Map();
  const milestones = [];
  for (const event of events) {
    if (!byItem.has(event.item_id)) byItem.set(event.item_id, []);
    byItem.get(event.item_id).push(event);
    if (event.event_kind.startsWith('milestone_')) milestones.push(event);
    try { details.set(event.event_id, JSON.parse(event.event_detail)); }
    catch { details.set(event.event_id, null); }
  }
  /** Current ordering proves an older inversion only when relevant recorded ordering stayed stable. */
  return (claim, ahead) => {
    const taken = (byItem.get(claim.item_id) ?? []).findLast(event => event.event_kind === 'claim'
      && event.event_by === claim.item_owner);
    if (!taken) return false;
    const candidateEvents = byItem.get(ahead.item_id) ?? [];
    const prior = candidateEvents.findLast(event => event.event_id < taken.event_id && MOVES.has(event.event_kind));
    if (!prior) return false;
    const wasFree = FREE.has(prior.event_kind) || (['claim', 'renew'].includes(prior.event_kind)
      && Date.parse(details.get(prior.event_id)?.leaseUntil ?? '') <= Date.parse(taken.event_at));
    if (!wasFree) return false;
    const hold = candidateEvents.findLast(event => event.event_id < taken.event_id
      && ['hold_item', 'unhold_item'].includes(event.event_kind));
    if (hold?.event_kind === 'hold_item') return false;
    // Membership history identifies the relevant roadmap even after an item is moved out of it.
    const names = new Set(milestones.filter(event => [details.get(event.event_id)?.items, details.get(event.event_id)?.add, details.get(event.event_id)?.remove]
        .some(ids => Array.isArray(ids) && ids.some(id => id === claim.item_id || id === ahead.item_id)))
      .map(event => details.get(event.event_id)?.name));
    return !milestones.some(event => event.event_id > taken.event_id
      && event.event_kind !== 'milestone_edit'
      && (!details.get(event.event_id) || names.has(details.get(event.event_id).name)
        || names.has(details.get(event.event_id).before) || names.has(details.get(event.event_id).into)));
  };
}
