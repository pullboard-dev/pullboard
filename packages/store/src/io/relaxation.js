import { ENGINE_VERSION } from '../../../state/index.js';
import { REVIEW_FAMILY_SEAT_ENGINE } from '../../../state/light.js';
import { REVIEW_RESERVATION_HEARTBEAT_TIMEOUT_MS } from './board/query.js';
/** Retain an item's frozen family authority when selecting and reserving its reviewer [V1,H16]. */
export function frozenFamilyPolicy(item, fallback) {
  try {
    const family = JSON.parse(item.item_frozen ?? '{}')?.policy?.verify?.family;
    return ['off', 'prefer', 'require'].includes(family) ? family : fallback;
  } catch { return fallback; }
}

/** The coordinator's claim-time snapshot is the only threshold authority [V1,H16]. */
export function frozenRelaxAt(item) {
  try {
    const value = JSON.parse(item.item_frozen ?? '{}')?.policy?.verify?.familyRelaxAt;
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
}

/** The active seats with no live review of their own: the reviewers a witness says could not take the queue; a fresh review heartbeat counts as live even with no recent event [V1,H16]. */
function freeActiveSeats(board, now, reviewHeartbeats = null) {
  const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const active = board.db.prepare('SELECT DISTINCT event.event_by AS id, agent.agent_lane AS lane FROM event JOIN agent ON agent.agent_id=event.event_by WHERE event.event_at>=? AND event.event_at<=? ORDER BY event.event_by')
    .all(cutoff, now.toISOString()).filter(row => (board.executionEngineVersion ?? ENGINE_VERSION) < REVIEW_FAMILY_SEAT_ENGINE || !['coordinator', 'person'].includes(row.lane)).map(row => row.id);
  const beating = reviewHeartbeats ? board.db.prepare('SELECT agent_id AS id, agent_lane AS lane FROM agent ORDER BY agent_id').all()
    .filter(row => Date.parse(reviewHeartbeats.get(row.id) ?? '') > now.getTime() - REVIEW_RESERVATION_HEARTBEAT_TIMEOUT_MS
      && ((board.executionEngineVersion ?? ENGINE_VERSION) < REVIEW_FAMILY_SEAT_ENGINE || !['coordinator', 'person'].includes(row.lane))).map(row => row.id) : [];
  const busy = new Set(board.db.prepare("SELECT item_review_by AS id FROM item WHERE item_status='submitted' AND item_review_by IS NOT NULL AND item_review_until>?")
    .all(now.toISOString()).map(row => row.id));
  return [...new Set([...active, ...beating])].sort().filter(id => !busy.has(id));
}

/** Whether no free seat may review the item: each is cooling down on it or refused by a reviewer check [V1,H16]. */
function blockedFor(board, item, seats, policy, { reviewerChecks, reviewReleaseCooldown, reviewHeartbeats = null }) {
  return !seats.some(id => {
    if (reviewReleaseCooldown(board, item.item_id, id)) return false;
    const checks = reviewerChecks(board, { agentId: id, policy, familyPolicy: 'require', reviewHeartbeats });
    return Object.values(checks).every(check => !check(item));
  });
}

/** Whether the subject and its reviewer may be relaxed at all: a standard same-family submission under a threshold. */
function relaxable(board, subject, agentId, threshold, { seatFamily, familiesDiffer, itemReviewPolicy, reviewHeartbeats = null }) {
  if (!Number.isSafeInteger(threshold) || threshold < 1 || subject.item_status !== 'submitted'
    || itemReviewPolicy(board, subject.item_id).tier !== 'standard') return false;
  const family = seatFamily(board, agentId);
  return Boolean(family && subject.item_builder_family && !familiesDiffer(board, family, subject.item_builder_family));
}

/** Derive a reservation witness from native events and the unreserved queue, reusing one selection's authority reads [V1,H16]. */
export function relaxationWitness(board, subject, agentId, threshold, policy, ports, cache = null) {
  const { reviewHolder, listItems, reviewHeartbeats = null } = ports;
  if (!relaxable(board, subject, agentId, threshold, ports)) return null;
  const cacheKey = `${agentId}:${threshold}:${policy}`;
  let state = cache?.get(cacheKey);
  if (!state) {
    const now = board.clock.now();
    const seats = freeActiveSeats(board, now, reviewHeartbeats);
    const waiting = listItems(board).filter(item => item.item_status === 'submitted' && !reviewHolder(board, item, reviewHeartbeats));
    const blocked = waiting.filter(item => blockedFor(board, item, seats, policy, ports));
    const ids = blocked.map(item => item.item_id).sort((a, b) => a - b);
    state = { waiting: ids, witness: blocked.length < threshold ? null
      : { version: 1, threshold, queueLength: blocked.length, waiting: ids, activeSeats: seats, at: now.toISOString() } };
    if (cache) cache.set(cacheKey, state);
  }
  return state.witness && state.waiting.includes(subject.item_id) ? state.witness : null;
}

/**
 * Confirm, inside the write lock, a witness built before it: the same free seats are active now, and the subject and
 * the witness's first threshold - 1 other waiting reviews are still unreserved, submitted, and blocked for every one of
 * those seats. It touches at most threshold entries and gives up on the first stale one. Returns the witness, or null when the board no longer supports it. Why: the
 * full witness checks every waiting review against every seat (0.5-0.9 s on a 28-submission board) and must never
 * run in the lock; the relaxation only needs the threshold to hold, so the lock checks threshold items, not the
 * whole queue (#3156).
 */
export function confirmRelaxation(board, subject, witness, agentId, threshold, policy, ports) {
  const { reviewHolder, getItem, reviewHeartbeats = null } = ports;
  if (!witness || witness.version !== 1 || witness.threshold !== threshold || !Array.isArray(witness.waiting)
    || !Array.isArray(witness.activeSeats) || !witness.waiting.includes(subject.item_id)) return null;
  const held = reservedRelaxation(board, subject, agentId);
  if (held) return JSON.stringify(held) === JSON.stringify(witness) ? witness : null;
  if (!relaxable(board, subject, agentId, threshold, ports) || reviewHolder(board, subject)) return null;
  const seats = freeActiveSeats(board, board.clock.now(), reviewHeartbeats);
  if (JSON.stringify(seats) !== JSON.stringify(witness.activeSeats)) return null;
  if (!blockedFor(board, subject, seats, policy, ports)) return null;
  // At most threshold entries in all: the subject and the first threshold - 1 others. The first stale one gives up
  // relaxing and the look runs again outside the lock, so a long stale list is never walked here.
  const others = [];
  for (const id of witness.waiting) {
    if (others.length >= threshold - 1) break;
    if (id !== subject.item_id) others.push(id);
  }
  if (others.length < threshold - 1) return null;
  for (const id of others) {
    let item;
    try { item = getItem(board, id); } catch (error) { if (error?.code === 'NO_ITEM') return null; throw error; }
    if (item?.item_status !== 'submitted' || reviewHolder(board, item) || !blockedFor(board, item, seats, policy, ports)) return null;
  }
  return witness;
}

/** Bind a previously granted witness to the same reviewer, source, and live reservation [V1,H16]. */
export function reservedRelaxation(board, item, agentId) {
  if (!item || item.item_review_by !== agentId || !item.item_review_until || item.item_review_until <= board.clock.now().toISOString()) return null;
  const row = board.db.prepare("SELECT event_by,event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(item.item_id);
  if (!row || row.event_by !== agentId) return null;
  try {
    const detail = JSON.parse(row.event_detail);
    const witness = detail.familyRelaxation;
    return detail.until === item.item_review_until && detail.commit === item.item_commit && detail.digest === item.item_frozen_digest
      && witness?.version === 1 && Array.isArray(witness.activeSeats) && witness.activeSeats.every(id => typeof id === 'string')
      && Array.isArray(witness.waiting) && witness.waiting.every(id => Number.isSafeInteger(id) && id > 0)
      && new Set(witness.waiting).size === witness.waiting.length && witness.waiting.includes(item.item_id)
      && Number.isSafeInteger(witness.queueLength) && witness.queueLength === witness.waiting.length && witness.queueLength >= witness.threshold
      && Number.isSafeInteger(witness.threshold) && witness.threshold > 0 && witness.threshold === frozenRelaxAt(item) ? witness : null;
  } catch { return null; }
}
