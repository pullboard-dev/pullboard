import { ENGINE_VERSION } from '../../../state/index.js';
import { REVIEW_FAMILY_SEAT_ENGINE } from '../../../../src/review-family-seat-engine.js';
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

/** Derive a reservation witness solely from native events and the current unreserved review queue [V1,H16]. */
export function relaxationWitness(board, subject, agentId, threshold, policy, { reviewerChecks, reviewHolder, reviewReleaseCooldown, listItems, seatFamily, familiesDiffer, itemReviewPolicy }) {
  if (!Number.isSafeInteger(threshold) || threshold < 1 || subject.item_status !== 'submitted'
    || itemReviewPolicy(board, subject.item_id).tier !== 'standard') return null;
  const family = seatFamily(board, agentId);
  if (!family || !subject.item_builder_family || familiesDiffer(board, family, subject.item_builder_family)) return null;
  const now = board.clock.now();
  const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const active = board.db.prepare('SELECT DISTINCT event.event_by AS id, agent.agent_lane AS lane FROM event JOIN agent ON agent.agent_id=event.event_by WHERE event.event_at>=? AND event.event_at<=? ORDER BY event.event_by')
    .all(cutoff, now.toISOString()).filter(row => (board.executionEngineVersion ?? ENGINE_VERSION) < REVIEW_FAMILY_SEAT_ENGINE || !['coordinator', 'person'].includes(row.lane)).map(row => row.id);
  const busy = new Set(board.db.prepare("SELECT item_review_by AS id FROM item WHERE item_status='submitted' AND item_review_by IS NOT NULL AND item_review_until>?")
    .all(now.toISOString()).map(row => row.id));
  const seats = active.filter(id => !busy.has(id));
  const waiting = listItems(board).filter(item => item.item_status === 'submitted' && !reviewHolder(board, item));
  const blocked = waiting.filter(item => !seats.some(id => {
    if (reviewReleaseCooldown(board, item.item_id, id)) return false;
    const checks = reviewerChecks(board, { agentId: id, policy, familyPolicy: 'require' });
    return Object.values(checks).every(check => !check(item));
  }));
  if (!blocked.some(item => item.item_id === subject.item_id) || blocked.length < threshold) return null;
  return { version: 1, threshold, queueLength: blocked.length, waiting: blocked.map(item => item.item_id).sort((a, b) => a - b), activeSeats: seats, at: now.toISOString() };
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
