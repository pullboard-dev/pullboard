/** Apply captured expiry decisions atomically without consulting replica-private liveness [B4,C7]. */
import { Refused } from './refused.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { STALE_STATE_ENGINE } from './stale-state-engine.js';
import {
  staleInstant,
  staleStateLimits,
} from './stale-state-policy.js';
import { planStaleState } from './stale-state-maintenance.js';

/** A malformed observation is a refusal, never permission to make a best-effort release. */
function invalid() {
  throw new Refused('BAD_STALE_STATE', 'stale-state maintenance needs complete captured native observations');
}

/** A later move must be observed before maintenance can act on its holder or hold. */
function changed() {
  throw new Refused('STALE_STATE_CHANGED', 'the board changed after the stale-state observation');
}

/** Bind the observation to this exact native event prefix before inspecting any candidate. */
function validateSnapshot(board, snapshot, health) {
  const now = board.clock.now().getTime();
  if (!snapshot || staleInstant(snapshot.observedAt, now) === null
    || !Number.isSafeInteger(snapshot.observedRevision) || snapshot.observedRevision < 0
    || !['holds', 'claims', 'reviews'].every(key => Array.isArray(snapshot[key]) && snapshot[key].length <= 10_000)) invalid();
  const limits = staleStateLimits({ health });
  if (Object.keys(limits).some(key => snapshot.limits?.[key] !== limits[key])) invalid();
  const revision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS revision FROM event').get().revision;
  if (snapshot.observedRevision !== revision) changed();
  return now;
}

/** Recheck the precise latest native event rather than relying on matching display text alone. */
function latestEvent(board, id, kind, actor) {
  return board.db.prepare('SELECT event_id,event_at FROM event WHERE item_id=? AND event_kind=? AND event_by=? ORDER BY event_id DESC LIMIT 1')
    .get(id, kind, actor);
}

/** Restrict automatic expiry to the observed coordinator hold; person and unrelated holds retain authority. */
function heldItem(board, row, getItem) {
  const item = getItem(board, row.id);
  const event = latestEvent(board, row.id, 'hold_item', 'coordinator');
  if (item.item_hold_by !== 'coordinator' || item.item_hold_at !== row.heldAt
    || item.item_hold_reason !== row.reason || event?.event_id !== row.holdEventId) changed();
  return item;
}

/** Confirm a full idle interval at or before the captured instant, not just at execution time. */
function observedExpiry(row, limit, observedAt) {
  const now = Date.parse(observedAt);
  const at = staleInstant(row.lastActivity ?? row.since, now);
  if (row.evidence?.complete !== true || at === null || row.limitMs !== limit || now - at < limit) invalid();
}

/** Apply one pure captured plan under coordinator authority and the ordinary board transaction. */
export function applyStaleState(board, { agentId, snapshot, health = {} }, dependencies) {
  const { atomic, getItem, setItem, releaseItemHold, logEvent, insertShout } = dependencies;
  if (agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator expires another holder or coordinator hold');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < STALE_STATE_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'stale-state maintenance needs an engine that preserves its captured observations');
  }
  return atomic(board, () => {
    validateSnapshot(board, snapshot, health);
    const plan = planStaleState(snapshot);
    const result = { warnings: [], holds: [], reviews: [] };
    /** Use the existing sentinel channel and direct recipient; item routing would replace the holder address. */
    const notice = (to, text, item) => insertShout(board, { from: 'sentinel', to, text, lanes: [], detail: { item } });
    /** Keep notices bounded while retaining the complete reason in the original hold event. */
    const shortReason = reason => String(reason).split(/[\r\n]/u)[0].slice(0, 180);
    for (const row of plan.holdWarnings) {
      heldItem(board, row, getItem);
      if (row.until !== null && row.until !== undefined) continue;
      const key = `stale_hold_warning:${row.id}`;
      if (board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key)?.meta_value === String(row.holdEventId)) continue;
      const heldAt = staleInstant(row.heldAt, Date.parse(snapshot.observedAt));
      const remaining = snapshot.limits.hold - (Date.parse(snapshot.observedAt) - heldAt);
      if (heldAt === null || remaining <= 0 || remaining > snapshot.limits.warning) invalid();
      board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, String(row.holdEventId));
      notice(agentId, `Hold on #${row.id} expires within one hour: ${shortReason(row.reason)}. Renew or lift it with pullboard hold ${row.id}.`, row.id);
      result.warnings.push(row.id);
    }
    for (const row of plan.holdExpiries) {
      heldItem(board, row, getItem);
      if (row.until !== null && row.until !== undefined) continue;
      observedExpiry({ ...row, lastActivity: row.heldAt }, snapshot.limits.hold, snapshot.observedAt);
      releaseItemHold(board, row.id, { agentId });
      notice(agentId, `Expired the coordinator hold on #${row.id} after its configured limit: ${shortReason(row.reason)}.`, row.id);
      result.holds.push(row.id);
    }
    for (const row of plan.reviewReleases) {
      const item = getItem(board, row.id);
      const reservation = latestEvent(board, row.id, 'reserve', row.reviewer);
      const submitted = board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(row.id);
      if (item.item_status !== 'submitted' || item.item_review_by !== row.reviewer || item.item_commit !== row.commit
        || item.item_review_until !== row.reviewUntil || reservation?.event_id !== row.reserveEventId
        || reservation?.event_at !== row.reservedAt || submitted?.event_id !== row.sourceSubmitEventId) changed();
      observedExpiry(row, snapshot.limits.review, snapshot.observedAt);
      const reason = `Review idle for 30 minutes; last observed activity ${row.lastActivity}.`;
      setItem(board, row.id, { item_review_by: null, item_review_until: null });
      logEvent(board, agentId, 'release', row.id, { review: true, reason,
        stale: { reviewer: row.reviewer, reservedAt: row.reservedAt, lastActivity: row.lastActivity } });
      notice(row.reviewer, `Released your idle review reservation on #${row.id}: ${reason} The item is available for independent review.`, row.id);
      result.reviews.push(row.id);
    }
    if (result.warnings.length || result.holds.length || result.reviews.length) {
      logEvent(board, agentId, 'stale_maintenance', null, { observedAt: snapshot.observedAt, ...result });
    }
    return result;
  });
}
