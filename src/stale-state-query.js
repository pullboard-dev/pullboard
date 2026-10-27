/** Indexed read-only stale-state observations; no Git scanner or write-board import on status [B4,C7]. */
import { withSeatPresence } from './seat-presence.js';
import {
  latestStaleActivity,
  staleInstant,
  staleStateAge,
  staleStateLimits,
} from './stale-state-policy.js';

/** Read recorded detail without letting incomplete legacy data establish expiry authority. */
function detailOf(event) {
  try { return event ? JSON.parse(event.event_detail) : null; }
  catch { return null; }
}

/** Read at most one current event through the existing item/event-id index. */
function itemEvent(board, id, kind, actor = null) {
  return board.db.prepare(`SELECT * FROM event WHERE item_id=? AND event_kind=?${actor === null ? '' : ' AND event_by=?'} ORDER BY event_id DESC LIMIT 1`)
    .get(id, kind, ...(actor === null ? [] : [actor])) ?? null;
}

/** Obtain the existing heartbeat projection once; unavailable observations remain unavailable. */
function observedSeats(board) {
  try {
    return new Map(withSeatPresence(board, board.db.prepare('SELECT agent_id FROM agent').all())
      .map(seat => [seat.agent_id, seat]));
  } catch { return new Map(); }
}

/** Combine only actually observed activity; absent work/heartbeat evidence never proves silence. */
function activity(board, item, actor, anchor, kind, seats, workObservation, now) {
  const unknown = [];
  const heartbeat = seats.get(actor)?.heartbeatAt;
  if (!heartbeat || staleInstant(heartbeat, now) === null) unknown.push('heartbeat unavailable or future');
  let work;
  try { work = workObservation(actor, item, kind); }
  catch { work = null; }
  if (work?.available !== true || work.at !== null && staleInstant(work?.at, now) === null) unknown.push('work observation unavailable or future');
  const proof = board.db.prepare(`SELECT event_at,event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind='proof-run'
    ${kind === 'review' ? "AND json_extract(event_detail,'$.receipt.commit')=?" : ''} ORDER BY event_id DESC LIMIT 1`)
    .get(item.item_id, actor, ...(kind === 'review' ? [item.item_commit] : []));
  const shout = board.db.prepare('SELECT shout_at FROM shout WHERE shout_from=? ORDER BY shout_at DESC LIMIT 1').get(actor);
  const observations = [anchor, heartbeat, work?.available === true ? work.at : null,
    proof?.event_at, detailOf(proof)?.receipt?.at, shout?.shout_at];
  const lastActivity = latestStaleActivity(observations, now);
  if (lastActivity === null || staleInstant(anchor, now) === null) unknown.push('activity boundary unavailable or future');
  return { lastActivity, evidence: { complete: unknown.length === 0, unknown } };
}

/** Retain malformed or future hold boundaries as explicit unknown evidence. */
function holdEvidence(bound, heldAt, now) {
  const unknown = [];
  if (!bound) unknown.push('hold event unavailable or mismatched');
  if (staleInstant(heldAt, now) === null) unknown.push('hold time unavailable or future');
  return { complete: unknown.length === 0, unknown };
}

/** Bind an extant item hold to its exact native event; unresolved conditions never become time-only holds. */
function itemHoldRow(board, item, limit, now) {
  const event = itemEvent(board, item.item_id, 'hold_item');
  const detail = detailOf(event);
  const bound = event?.event_at === item.item_hold_at && event?.event_by === item.item_hold_by
    && detail?.reason === item.item_hold_reason;
  return { ...staleStateAge('hold', item.item_id, item.item_hold_by, item.item_hold_at, limit, now),
    scope: 'item', heldAt: item.item_hold_at, reason: item.item_hold_reason, holdEventId: event?.event_id ?? null,
    until: detail?.until ?? null, lastActivity: item.item_hold_at,
    evidence: holdEvidence(bound, item.item_hold_at, now) };
}

/** Include lane holds in status without interpreting them as an item-id condition. */
function laneHoldRow(board, hold, limit, now) {
  const event = board.db.prepare("SELECT * FROM event WHERE event_kind='hold' AND json_extract(event_detail,'$.lane')=? ORDER BY event_id DESC LIMIT 1").get(hold.hold_lane);
  const detail = detailOf(event);
  const bound = event?.event_at === hold.hold_at && event?.event_by === hold.hold_by && detail?.reason === hold.hold_reason;
  return { ...staleStateAge('hold', hold.hold_lane, hold.hold_by, hold.hold_at, limit, now),
    scope: 'lane', heldAt: hold.hold_at, reason: hold.hold_reason, holdEventId: event?.event_id ?? null,
    until: detail?.until ?? null, lastActivity: hold.hold_at,
    evidence: holdEvidence(bound, hold.hold_at, now) };
}

/** Project a claim's known age for status, retaining incomplete work evidence explicitly. */
function claimRow(board, item, limits, now, seats, options) {
  const event = itemEvent(board, item.item_id, 'claim', item.item_owner);
  const observed = activity(board, item, item.item_owner, event?.event_at, 'claim', seats, options.workObservation, now);
  const blocker = options.blocker(item);
  const classificationUnknown = blocker !== true && blocker !== false;
  if (classificationUnknown) {
    observed.evidence.complete = false;
    observed.evidence.unknown.push('blocker classification unavailable');
  }
  // Unknown classification can show an early warning, never authorize the shorter release interval.
  const limit = classificationUnknown ? Math.min(limits.blocker, limits.claim) : blocker ? limits.blocker : limits.claim;
  const age = staleStateAge('claim', item.item_id, item.item_owner, observed.lastActivity ?? event?.event_at, limit, now);
  return { ...age, ...observed, blocker: classificationUnknown ? null : blocker === true, classificationUnknown, leaseUntil: item.item_lease_until, claimEventId: event?.event_id ?? null,
    expiryAuthorized: false };
}

/** Bind a review candidate to current head, latest reserve and exact native submission, not lease age alone. */
function reviewRow(board, item, limits, now, seats, options) {
  const reserve = itemEvent(board, item.item_id, 'reserve');
  const submit = itemEvent(board, item.item_id, 'submit');
  const observed = activity(board, item, item.item_review_by, reserve?.event_at, 'review', seats, options.workObservation, now);
  const bound = reserve?.event_by === item.item_review_by && detailOf(reserve)?.until === item.item_review_until
    && submit?.event_id < reserve?.event_id && detailOf(submit)?.commit === item.item_commit;
  if (!bound) observed.evidence.unknown.push('reservation or submission binding unavailable');
  observed.evidence.complete &&= Boolean(bound);
  return { ...staleStateAge('review', item.item_id, item.item_review_by, observed.lastActivity ?? reserve?.event_at, limits.review, now),
    ...observed, reviewer: item.item_review_by, commit: item.item_commit, reservedAt: reserve?.event_at ?? null,
    reserveEventId: reserve?.event_id ?? null, reviewUntil: item.item_review_until,
    sourceSubmitEventId: submit?.event_id ?? null, expiryAuthorized: false };
}

/** Read only current state and indexed activity; callbacks supply actual work without importing Git on fast status. */
export function staleStateSnapshot(board, config = {}, { now = board.clock.now(),
  workObservation = () => ({ available: false, at: null }), blocker = () => false, seats: suppliedSeats } = {}) {
  const at = now.getTime();
  const limits = staleStateLimits(config);
  const observedRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id;
  const seats = suppliedSeats === undefined ? observedSeats(board) : new Map(suppliedSeats.map(seat => [seat.agent_id, seat]));
  const options = { workObservation, blocker };
  const items = board.db.prepare("SELECT * FROM item WHERE item_hold_reason IS NOT NULL OR item_status='claimed' OR item_status='submitted'").all();
  return { observedAt: now.toISOString(), observedRevision, limits,
    holds: [...items.filter(item => item.item_hold_reason).map(item => itemHoldRow(board, item, limits.hold, at)),
      ...board.db.prepare('SELECT * FROM hold ORDER BY hold_lane').all().map(hold => laneHoldRow(board, hold, limits.hold, at))],
    claims: items.filter(item => item.item_status === 'claimed' && item.item_owner).map(item => claimRow(board, item, limits, at, seats, options)),
    reviews: items.filter(item => item.item_status === 'submitted' && item.item_review_by).map(item => reviewRow(board, item, limits, at, seats, options)) };
}
