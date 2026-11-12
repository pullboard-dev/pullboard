import { STRANDED_DEPENDENCY_ENGINE } from '../../../../../state/index.js';
import { claimProgress } from '../../../../../items/index.js';
import { CLAIM_RETURNS_ENGINE } from '../../../../../state/index.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
/** Indexed read-only stale-state observations; no Git scanner or write-board import on status [B4,C7]. */
import { latestStaleActivity } from '../../../../../store/index.js';
import { staleInstant } from '../../../../../store/index.js';
import { staleStateAge } from '../../../../../store/index.js';
import { staleStateLimits } from '../../../../../store/index.js';

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
function observedSeats(withSeatPresence, board, actors) {
  try {
    return new Map(withSeatPresence(board, actors ? [...new Set(actors)].map(agent_id => ({ agent_id })) : board.db.prepare('SELECT agent_id FROM agent').all())
      .map(seat => [seat.agent_id, seat]));
  } catch { return new Map(); }
}

/**
 * Combine only actually observed activity. For a review, absent work or heartbeat evidence never proves silence.
 * A claim past its lease belongs to its seat id (#1933, coordinator 30 Oct): only board writes, shouts, proofs and
 * heartbeats under that id count, so a seat with no presence reads as absent and a checkout's file activity, which a reused or gone
 * checkout cannot attribute to the seat, is neither required nor read.
 */
function activity(board, item, actor, anchor, kind, seats, workObservation, now, episodeAt = null) {
  const unknown = [];
  // Only once the lease has ended; a live claim's checkout work still protects a builder editing without board writes.
  const seatOnly = kind === 'claim' && staleInstant(item.item_lease_until, now) !== null && Date.parse(item.item_lease_until) <= now;
  const heartbeat = seats.get(actor)?.heartbeatAt;
  if (heartbeat ? staleInstant(heartbeat, now) === null : !seatOnly) unknown.push('heartbeat unavailable or future');
  let work = null;
  if (!seatOnly) {
    try { work = workObservation(actor, item, kind); }
    catch { work = null; }
    if (work?.available !== true || work.at !== null && staleInstant(work?.at, now) === null) unknown.push('work observation unavailable or future');
  }
  const proof = board.db.prepare(`SELECT event_at,event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind='proof-run'
    ${kind === 'review' ? "AND json_extract(event_detail,'$.receipt.commit')=?" : ''} ORDER BY event_id DESC LIMIT 1`)
    .get(item.item_id, actor, ...(kind === 'review' ? [item.item_commit] : []));
  const native = board.db.prepare('SELECT event_at FROM event WHERE event_by=? ORDER BY event_id DESC LIMIT 1').get(actor);
  const shout = board.db.prepare('SELECT shout_at FROM shout WHERE shout_from=? ORDER BY shout_at DESC LIMIT 1').get(actor);
  const observations = [anchor, heartbeat, work?.available === true ? work.at : null,
    proof?.event_at, detailOf(proof)?.receipt?.at, shout?.shout_at, native?.event_at];
  const lastActivity = latestStaleActivity(observations, now);
  if (lastActivity === null || staleInstant(anchor, now) === null) unknown.push('activity boundary unavailable or future');
  // The idle rule (#1225) reads real work only: worktree commits and file changes, board-run proofs and the holder's
  // own moves on the item. A heartbeat, a shout or a renewal is the agent reporting itself, so none of them counts.
  if (kind !== 'claim' || seatOnly) return { lastActivity, evidence: { complete: unknown.length === 0, unknown } };
  const move = board.db.prepare(`SELECT event_at FROM event WHERE event_by=? AND item_id=? AND event_kind NOT IN (${RENEWALS}) ORDER BY event_id DESC LIMIT 1`).get(actor, item.item_id);
  const workSeen = work?.available === true && (work.at === null || staleInstant(work.at, now) !== null);
  const workActivity = workSeen && staleInstant(episodeAt, now) !== null
    ? latestStaleActivity([episodeAt, work.at, proof?.event_at, detailOf(proof)?.receipt?.at, move?.event_at], now) : null;
  return { lastActivity, workActivity, commitAt: work?.available === true ? work.commitAt ?? null : null, evidence: { complete: unknown.length === 0, unknown } };
}

/** Board events that renew or restate a claim; none of them is work on it. */
export const RENEWALS = "'claim','renew','heartbeat','claim_stalled'";
/** A claim shows as stalled after this much idle time, and is released at the second (#1225). */
export const CLAIM_STALL_MS = 20 * 60_000;
/** A holder who committed this recently is never returned by the progress rule (#2251). */
export const CLAIM_RECENT_COMMIT_MS = 30 * 60_000;
export const CLAIM_IDLE_RELEASE_MS = 40 * 60_000;

/** When the holder's current claim began: its first claim since the item last left that holder's hands. Renewals do not move it. */
function claimEpisode(board, item) {
  const boundary = board.db.prepare("SELECT COALESCE(MAX(event_id),0) AS id FROM event WHERE item_id=? AND event_kind IN ('release','submit','reopen','withdraw','merged','accept','reject','refreeze')")
    .get(item.item_id).id;
  return board.db.prepare("SELECT event_id,event_at FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' AND event_id>? ORDER BY event_id LIMIT 1")
    .get(item.item_id, item.item_owner, boundary) ?? null;
}

/** The local items a claim still waits on: dependencies not yet landed. */
function waitingOn(board, item) {
  const ids = String(item.item_after ?? '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  return ids.filter(id => {
    const row = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_id=?').get(id);
    return row && row.item_status !== 'withdrawn' && !row.item_merged_commit;
  });
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
  const lease = board.db.prepare("SELECT event_id,event_at,event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind IN ('claim','renew') ORDER BY event_id DESC LIMIT 1").get(item.item_id, item.item_owner);
  const episode = claimEpisode(board, item);
  const observed = activity(board, item, item.item_owner, event?.event_at, 'claim', seats, options.workObservation, now, episode?.event_at ?? null);
  const blocker = options.blocker(item);
  const classificationUnknown = blocker !== true && blocker !== false;
  if (classificationUnknown) {
    observed.evidence.complete = false;
    observed.evidence.unknown.push('blocker classification unavailable');
  }
  // Unknown classification can show an early warning, never authorize the shorter release interval.
  const limit = classificationUnknown ? Math.min(limits.blocker, limits.claim) : blocker ? limits.blocker : limits.claim;
  const age = staleStateAge('claim', item.item_id, item.item_owner, observed.lastActivity ?? event?.event_at, limit, now);
  return { ...age, ...observed, blocker: classificationUnknown ? null : blocker === true, classificationUnknown, leaseUntil: item.item_lease_until, claimAt: event?.event_at ?? null,
    heartbeatAt: seats.get(item.item_owner)?.heartbeatAt ?? null, claimEventId: event?.event_id ?? null,
    leaseEventId: lease?.event_id ?? null, leaseStartedAt: lease?.event_at ?? null, leaseMs: Date.parse(item.item_lease_until) - Date.parse(lease?.event_at),
    progress: claimProgress(board, item, now, { runnerOnly: (board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_RETURNS_ENGINE }), commitAt: observed.commitAt ?? null, episodeEventId: episode?.event_id ?? null, ...claimHealth(board, item, observed, now), expiryAuthorized: false };
}

/** Building, stalled (20 idle minutes) or waiting on an unlanded item, from real work signals only (#1225). */
function claimHealth(board, item, observed, now) {
  const waiting = waitingOn(board, item);
  if (waiting.length) return { health: 'waiting', waitingOn: waiting, idleMs: null };
  const last = observed.workActivity ? staleInstant(observed.workActivity, now) : null;
  const idleMs = last === null ? null : now - last;
  return { health: idleMs !== null && idleMs >= CLAIM_STALL_MS ? 'stalled' : 'building', waitingOn: [], idleMs };
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

/**
 * Read only current state and indexed activity; callbacks supply actual work without importing Git on fast status.
 * Why: the heartbeat projection lives in the store's shell, so the shell hands it in as `withSeatPresence` [C7].
 *
 * @param {(board: any, seats: { agent_id: string }[]) => any[]} withSeatPresence
 */
export function staleStateSnapshotWith(withSeatPresence, board, config = {}, { now = board.clock.now(),
  workObservation = () => ({ available: false, at: null }), blocker = () => false, seats: suppliedSeats, items: suppliedItems, claimsOnly = false } = {}) {
  const at = now.getTime();
  const limits = staleStateLimits(config, { dependency: (board.executionEngineVersion ?? ENGINE_VERSION) >= STRANDED_DEPENDENCY_ENGINE });
  const observedRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id;
  const seats = suppliedSeats === undefined ? observedSeats(withSeatPresence, board, claimsOnly ? suppliedItems.map(item => item.item_owner) : undefined) : new Map(suppliedSeats.map(seat => [seat.agent_id, seat]));
  const options = { workObservation, blocker };
  const items = suppliedItems ?? board.db.prepare("SELECT * FROM item WHERE item_hold_reason IS NOT NULL OR item_status='claimed' OR item_status='submitted'").all();
  return { observedAt: now.toISOString(), observedRevision, limits,
    holds: claimsOnly ? [] : [...items.filter(item => item.item_hold_reason).map(item => itemHoldRow(board, item, limits.hold, at)),
      ...board.db.prepare('SELECT * FROM hold ORDER BY hold_lane').all().map(hold => laneHoldRow(board, hold, limits.hold, at))],
    claims: items.filter(item => item.item_status === 'claimed' && item.item_owner).map(item => claimRow(board, item, limits, at, seats, options)),
    reviews: claimsOnly ? [] : items.filter(item => item.item_status === 'submitted' && item.item_review_by).map(item => reviewRow(board, item, limits, at, seats, options)) };
}
