/** Count recorded build claims released before a submit, verdict or send-back, by UTC day [C7]. */
export function workFreeReleases(events, { since = null } = {}) {
  const claims = new Map(), counts = new Map();
  for (const event of events) {
    if (event.item_id == null) continue;
    let detail;
    try { detail = typeof event.event_detail === 'string' ? JSON.parse(event.event_detail) : event.event_detail ?? {}; }
    catch { detail = {}; }
    const id = event.item_id, kind = event.event_kind;
    if (kind === 'claim') {
      const previous = claims.get(id);
      if (!previous || previous.seat !== event.event_by || previous.until && previous.until <= event.event_at) claims.set(id, { seat: event.event_by, worked: false, until: detail.leaseUntil });
      else if (detail.leaseUntil) previous.until = detail.leaseUntil;
    } else if (kind === 'renew') {
      const claim = claims.get(id);
      if (claim && detail.leaseUntil) claim.until = detail.leaseUntil;
    } else if (['submit', 'accept', 'reject', 'reopen', 'send-back'].includes(kind)) {
      const claim = claims.get(id);
      if (claim) claim.worked = true;
    } else if (kind === 'release' && !detail.review) {
      const claim = claims.get(id);
      if (claim && !claim.worked && /^\d{4}-\d\d-\d\dT/u.test(event.event_at ?? '') && (!since || event.event_at >= since)) {
        const day = event.event_at.slice(0, 10), reason = detail.reasonCode ?? 'UNKNOWN';
        const key = JSON.stringify([day, claim.seat, reason]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      claims.delete(id);
    } else if (['lapse', 'withdraw', 'merged'].includes(kind)) claims.delete(id);
  }
  return [...counts].map(([key, count]) => { const [day, seat, reason] = JSON.parse(key); return { day, seat, reason, count }; })
    .sort((a, b) => a.day.localeCompare(b.day) || a.seat.localeCompare(b.seat) || a.reason.localeCompare(b.reason));
}

/** Read only the lifecycle events needed to reconstruct claim boundaries. */
export function readWorkFreeReleases(db, options) {
  return workFreeReleases(db.prepare("SELECT event_id,event_at,event_by,event_kind,item_id,event_detail FROM event WHERE event_kind IN ('claim','renew','release','submit','accept','reject','reopen','send-back','lapse','withdraw','merged') ORDER BY event_id").all(), options);
}
