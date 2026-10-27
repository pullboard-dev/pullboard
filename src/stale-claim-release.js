/** Captured coordinator stale-claim authority, independent of replica-local Git and heartbeat state [B4,H16]. */
import { Refused } from './refused.js';
import { STALE_STATE_ENGINE } from './stale-state-engine.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import {
  staleInstant,
  staleReleaseNote,
  staleStateLimits,
} from './stale-state-policy.js';

/** Validate exact current ownership and a complete observed idle interval before ordinary release. */
export function staleClaimRelease(board, item, actor, note, captured) {
  if (!captured || !Object.hasOwn(captured, 'staleClaim')) return null;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < STALE_STATE_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'stale claim releases require replay-aware writers; upgrade every linked device');
  }
  if (actor !== 'coordinator') throw new Refused('NOT_YOURS', 'only the coordinator may release another holder with --stale');
  const reason = staleReleaseNote(note);
  const row = captured.staleClaim;
  const now = board.clock.now().getTime();
  const observed = staleInstant(captured.observedAt, now);
  const last = observed === null ? null : staleInstant(row?.lastActivity, observed);
  const revision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id;
  const claim = board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' ORDER BY event_id DESC LIMIT 1").get(item.item_id, item.item_owner);
  const limits = staleStateLimits({ health: captured.health });
  const limit = row?.blocker === true ? limits.blocker : limits.claim;
  if (item.item_status !== 'claimed' || item.item_owner !== row?.actor || item.item_id !== row?.id
    || item.item_lease_until !== row?.leaseUntil || !(item.item_lease_until > board.clock.now().toISOString())
    || claim?.event_id !== row?.claimEventId || captured.observedRevision !== revision) {
    throw new Refused('NOT_YOURS', 'the claim changed after the stale observation; capture it again before releasing');
  }
  if (observed === null || last === null || row.evidence?.complete !== true || row.limitMs !== limit || observed - last < limit) {
    throw new Refused('NOT_YOURS', 'complete activity evidence does not establish the configured stale interval');
  }
  return { holder: item.item_owner, lastActivity: row.lastActivity, observedAt: captured.observedAt,
    claimEventId: row.claimEventId, limitMs: limit, blocker: row.blocker === true, reason };
}
