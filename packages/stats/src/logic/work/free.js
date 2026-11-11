/** An empty claim-release fold: the open claims, the day, seat and reason counts, and the last event folded. */
function newReleaseFold() {
  return { claims: new Map(), counts: new Map(), last: 0 };
}

/** Fold events, in event order, into the open claims and the counts. */
function foldReleases(fold, events, since) {
  const { claims, counts } = fold;
  for (const event of events) {
    if (Number.isSafeInteger(event.event_id) && event.event_id > fold.last) fold.last = event.event_id;
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
  return fold;
}

/** The counts a fold holds, one row per day, seat and reason. */
function releaseRows(fold) {
  return [...fold.counts].map(([key, count]) => { const [day, seat, reason] = JSON.parse(key); return { day, seat, reason, count }; })
    .sort((a, b) => a.day.localeCompare(b.day) || a.seat.localeCompare(b.seat) || a.reason.localeCompare(b.reason));
}

/** Count recorded build claims released before a submit, verdict or send-back, by UTC day [C7]. */
export function workFreeReleases(events, { since = null } = {}) {
  return releaseRows(foldReleases(newReleaseFold(), events, since));
}

/** The lifecycle events that reconstruct claim boundaries. */
const LIFECYCLE = "event_kind IN ('claim','renew','release','submit','accept','reject','reopen','send-back','lapse','withdraw','merged')";
/** Each board file's kept fold per since boundary. */
const keptFolds = new Map();

/**
 * Read only the lifecycle events needed to reconstruct claim boundaries. A file board keeps its fold and reads only
 * the events past the last one folded [C7]. Why: the event log only grows, and folding all of it again cost every
 * state build a scan of the whole log. A kept fold whose last event is gone (a replaced board) starts over.
 */
export function readWorkFreeReleases(db, options = {}) {
  const since = options.since ?? null;
  const file = typeof db.location === 'function' ? db.location() : null;
  const read = (after) => db.prepare(`SELECT event_id,event_at,event_by,event_kind,item_id,event_detail FROM event WHERE ${LIFECYCLE} AND event_id > ? ORDER BY event_id`).all(after);
  if (!file) return releaseRows(foldReleases(newReleaseFold(), read(0), since));
  const id = `${file}\0${since}`;
  let fold = keptFolds.get(id);
  if (fold && fold.last > 0 && !db.prepare('SELECT 1 FROM event WHERE event_id = ?').get(fold.last)) fold = null;
  fold ??= newReleaseFold();
  keptFolds.set(id, foldReleases(fold, read(fold.last), since));
  return releaseRows(fold);
}
