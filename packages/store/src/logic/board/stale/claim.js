/** Captured coordinator stale-claim authority, independent of replica-local Git and heartbeat state [B4,H16]. */
import { Refused } from "../../../../../kernel/light.js";
import { LEASE_LAPSE_ENGINE } from "../../../../../state/light.js";
import { STALE_STATE_ENGINE } from "../../../../../state/light.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { SEAT_GONE_RELEASE_ENGINE } from "../../../../../state/light.js";
import {
  staleInstant,
  staleReleaseNote,
  staleStateLimits,
} from "./state/policy.js";

/** Validate exact current ownership and a complete observed idle interval before ordinary release. */
export function staleClaimRelease(board, item, actor, note, captured) {
  if (!captured || !Object.hasOwn(captured, 'staleClaim')) return null;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < STALE_STATE_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'stale claim releases require replay-aware writers; upgrade every linked device');
  }
  if (actor !== 'coordinator') throw new Refused('NOT_YOURS', 'only the coordinator may release another holder with --stale');
  if (captured.leaseLapse === true && (board.executionEngineVersion ?? ENGINE_VERSION) < LEASE_LAPSE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before releasing a lapsed claim');
  const reason = staleReleaseNote(note);
  const row = captured.staleClaim;
  const now = board.clock.now().getTime();
  const observed = staleInstant(captured.observedAt, now);
  const last = observed === null ? null : staleInstant(row?.lastActivity, observed);
  const revision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id;
  const claim = board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' ORDER BY event_id DESC LIMIT 1").get(item.item_id, item.item_owner);
  const limits = staleStateLimits({ health: captured.health });
  const limit = row?.blocker === true ? limits.blocker : limits.claim;
  // A holder whose registered worktree folder is gone cannot be working there, so no stale interval applies (#3223).
  const registered = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(item.item_owner)?.agent_path;
  const folderGone = (board.executionEngineVersion ?? ENGINE_VERSION) >= SEAT_GONE_RELEASE_ENGINE
    && typeof row?.seatFolderMissing === 'string' && row.seatFolderMissing === registered;
  if (item.item_status !== 'claimed' || item.item_owner !== row?.actor || item.item_id !== row?.id
    || item.item_lease_until !== row?.leaseUntil
    || (captured.leaseLapse !== true || (board.executionEngineVersion ?? ENGINE_VERSION) < LEASE_LAPSE_ENGINE) && !(item.item_lease_until > board.clock.now().toISOString())
    || claim?.event_id !== row?.claimEventId || captured.observedRevision !== revision) {
    throw new Refused('NOT_YOURS', 'the claim changed after the stale observation; capture it again before releasing');
  }
  if (!folderGone && (observed === null || last === null || row.evidence?.complete !== true || row.limitMs !== limit || observed - last < limit)) {
    throw new Refused('NOT_YOURS', 'complete activity evidence does not establish the configured stale interval');
  }
  let lapsed = {};
  if (!folderGone && captured.leaseLapse === true && item.item_lease_until <= board.clock.now().toISOString()) {
    if (observed - Date.parse(item.item_lease_until) < limit) throw new Refused('NOT_YOURS', 'the expired lease has not passed its configured stale interval; wait for that interval before releasing');
    const lease = board.db.prepare("SELECT event_id,event_at,event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind IN ('claim','renew') ORDER BY event_id DESC LIMIT 1").get(item.item_id, item.item_owner);
    const leaseMs = Date.parse(item.item_lease_until) - Date.parse(lease?.event_at);
    if (!lease || lease?.event_id !== row.leaseEventId || lease?.event_at !== row.leaseStartedAt || row.leaseMs !== leaseMs
      || JSON.parse(lease.event_detail).leaseUntil !== row.leaseUntil || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Refused('NOT_YOURS', 'the claim lease changed after the stale observation; capture it again');
    }
    lapsed = { expiredClaim: { holder: item.item_owner, leaseUntil: item.item_lease_until, lastActivity: row.lastActivity,
      observedAt: captured.observedAt, leaseEventId: row.leaseEventId },
      reopenFirstRefusal: { builder: item.item_owner, until: new Date(now + leaseMs).toISOString() } };
  }
  return { holder: item.item_owner, lastActivity: row.lastActivity, observedAt: captured.observedAt,
    claimEventId: row.claimEventId, limitMs: limit, ...lapsed, blocker: row.blocker === true,
    ...(folderGone ? { seatFolderMissing: registered, reason: `registered worktree no longer exists: ${registered}; ${reason}` } : { reason }) };
}
