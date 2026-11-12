import { STRANDED_DEPENDENCY_ENGINE } from '../../../../../state/index.js';
import { dependencyWaiters } from '../../../../../items/index.js';
import { dependencyWorkAt } from '../../../../../items/index.js';
import { CLAIM_PROGRESS_ENGINE } from '../../../../../state/index.js';
import { CLAIM_RETURNS_ENGINE } from '../../../../../state/index.js';
import { claimProgress } from '../../../../../items/index.js';
/** Apply captured expiry decisions atomically without consulting replica-private liveness [B4,C7]. */
import { Refused } from "../../../../../kernel/light.js";
import { IN_STATE } from "../../../../../state/index.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { LEASE_LAPSE_ENGINE } from "../../../../../state/light.js";
import { STALE_STATE_ENGINE } from "../../../../../state/light.js";
import { CLAIM_IDLE_ENGINE } from "../../../../../state/light.js";
import { QUEUED_RED_RETURN_ENGINE } from "../../../../../state/light.js";
import { redReturnLeaseHolds } from "../../red/return.js";
import { PINNED_CLAIM_LAPSE_ENGINE } from "../../../../../state/light.js";
import { PINNED_CLAIM_RELEASE_MS } from "../../pinned.js";
import { itemPinned } from "../../pinned.js";

/** A claim shows as stalled after 20 idle minutes and is released at 40 (#1225); kept beside the health reader's copy. */
const CLAIM_STALL_MS = 20 * 60_000;
/** A holder who committed this recently is never returned by the progress rule. */
const RECENT_COMMIT_MS = 30 * 60_000;
const CLAIM_IDLE_RELEASE_MS = 40 * 60_000;
import { RELEASE_REASONS_ENGINE } from "../../../../../state/index.js";
import {
  staleInstant,
  staleStateLimits,
} from "./state/policy.js";
import { planStaleState } from "./state/maintenance.js";

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
  const limits = staleStateLimits({ health }, { dependency: (board.executionEngineVersion ?? ENGINE_VERSION) >= STRANDED_DEPENDENCY_ENGINE });
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

/** One line naming the kept work: the pinned ref and changed files (bounded, with the rest counted), or why nothing was pinned. */
export function handoffText(handoff) {
  if (!handoff.pin) return `no work could be pinned: ${handoff.unpinned}`;
  const shown = handoff.changedFiles.slice(0, 8);
  const more = handoff.changedCount - shown.length;
  return `work kept at ${handoff.pin} (${handoff.changedCount} file(s): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''})`;
}

/** The lane's lead seat, or the coordinator when the lane has none. */
function laneLead(board, lane) {
  let leads = {};
  try { leads = JSON.parse(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='lane_leads'").get()?.meta_value ?? '{}'); }
  catch { leads = {}; /* An unreadable lead policy routes to the coordinator, who is always a valid recipient. */ }
  const seat = leads[lane];
  return typeof seat === 'string' && board.db.prepare('SELECT 1 FROM agent WHERE agent_id=? AND agent_lane=?').get(seat, lane) ? seat : 'coordinator';
}

/**
 * Re-check one captured idle or waiting claim against the board (#1225): the same holder and claim, a complete
 * observation old enough for its rule, and for a waiting claim a dependency that has still not landed. Renewals do not
 * count as work, so a renewed lease never invalidates the idle interval; any other move does.
 */
function idleClaim(board, row, snapshot, agentId, itemById) {
  const item = itemById(board, row.id);
  const claim = board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' ORDER BY event_id DESC LIMIT 1").get(row.id, row.actor);
  if (item.item_status !== 'claimed' || item.item_owner !== row.actor || item.item_owner === agentId || claim?.event_id !== row.claimEventId) changed();
  if (!['stall', 'release', 'waiting', 'progress', 'seat-gone', 'dependency'].includes(row.idle)) invalid();
  if (row.idle === 'seat-gone') {
    const signal = row.deadSeat?.heartbeatAt ?? row.claimAt;
    const at = Date.parse(snapshot.observedAt), last = Date.parse(signal ?? '');
    if (row.deadSeat?.observedAt !== snapshot.observedAt || row.deadSeat?.quietMs !== 120_000
      || row.deadSeat?.worktreeMissing !== true && (!Number.isFinite(last) || at - last < 120_000)) invalid();
    return { row, item };
  }
  if (row.idle === 'waiting') {
    if (!Array.isArray(row.waitingOn) || !row.waitingOn.length) invalid();
    const after = String(item.item_after ?? '').split(',').map(Number);
    const open = row.waitingOn.filter(id => after.includes(id) && (() => {
      const dependency = board.db.prepare('SELECT item_status,item_merged_commit FROM item WHERE item_id=?').get(id);
      return dependency && dependency.item_status !== 'withdrawn' && !dependency.item_merged_commit;
    })());
    if (open.length !== row.waitingOn.length) changed();
    return { row, item };
  }
  const observed = Date.parse(snapshot.observedAt);
  if ((board.executionEngineVersion ?? ENGINE_VERSION) >= QUEUED_RED_RETURN_ENGINE && redReturnLeaseHolds(board, item, observed)) changed();
  if (row.idle === 'progress' && (board.executionEngineVersion ?? ENGINE_VERSION) < CLAIM_PROGRESS_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before automatic progress-claim release');
  const progress = row.idle === 'progress' ? claimProgress(board, item, observed, { runnerOnly: (board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_RETURNS_ENGINE }) : null;
  // A holder who committed in the last 30 minutes is working, whatever the failures or the clock say [B4,B5].
  if (progress && (board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_RETURNS_ENGINE && row.commitAt != null
    && observed - Date.parse(row.commitAt) < RECENT_COMMIT_MS) invalid();
  if (progress && (!progress.trigger || JSON.stringify(progress) !== JSON.stringify(row.progress))) invalid();
  if (row.idle === 'dependency') {
    if ((board.executionEngineVersion ?? ENGINE_VERSION) < STRANDED_DEPENDENCY_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before reclaiming a stranded dependency');
    const waiters = dependencyWaiters(board, row.id).map(entry => entry.item_id);
    if (!waiters.length || JSON.stringify(waiters) !== JSON.stringify(row.dependents)) changed();
    const lastWork = dependencyWorkAt(board, item, row.commitAt, observed);
    if (row.resourceQuiet !== true || !lastWork || lastWork !== row.workActivity || row.idleMs !== observed - Date.parse(lastWork)
      || row.idleMs < snapshot.limits.dependency) invalid();
  }
  const last = staleInstant(row.workActivity, observed);
  const pinnedLapse = row.idle === 'release' && (board.executionEngineVersion ?? ENGINE_VERSION) >= PINNED_CLAIM_LAPSE_ENGINE && itemPinned(board, item.item_id);
  const limit = row.idle === 'dependency' ? snapshot.limits.dependency : row.idle === 'release' ? (pinnedLapse ? PINNED_CLAIM_RELEASE_MS : CLAIM_IDLE_RELEASE_MS) : CLAIM_STALL_MS;
  if (!progress && (last === null || row.idleMs !== observed - last || row.idleMs < limit)) invalid();
  if (['release', 'progress', 'dependency'].includes(row.idle) && (!row.handoff || !Array.isArray(row.handoff.changedFiles) || row.handoff.changedFiles.length > 200
    || !Number.isSafeInteger(row.handoff.changedCount) || row.handoff.changedCount < row.handoff.changedFiles.length
    || (row.handoff.pin === null ? typeof row.handoff.unpinned !== 'string' || !row.handoff.unpinned
      : !/^[0-9a-f]{40,64}$/u.test(row.handoff.head ?? '') || typeof row.handoff.pin !== 'string' || !row.handoff.pin.startsWith(`refs/pullboard/handoffs/${row.id}/`)))) invalid();
  return { row, item };
}

/** Apply one pure captured plan under coordinator authority and the ordinary board transaction. */
export function applyStaleState(board, { agentId, snapshot, health = {}, claimsOnly = false }, dependencies) {
  const { atomic, getItem, itemById, setItem, releaseItemHold, logEvent, insertShout, moveItem } = dependencies;
  if (claimsOnly !== false && claimsOnly !== true) invalid();
  if (claimsOnly && (board.executionEngineVersion ?? ENGINE_VERSION) < LEASE_LAPSE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before automatic lapsed-claim expiry');
  if (claimsOnly && !board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(agentId)) throw new Refused('NOT_JOINED', 'join a lane before maintaining lapsed claims');
  if (!claimsOnly && agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator expires another holder or coordinator hold');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < STALE_STATE_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'stale-state maintenance needs an engine that preserves its captured observations');
  }
  return atomic(board, () => {
    validateSnapshot(board, snapshot, health);
    if (claimsOnly && (snapshot.holds.length || snapshot.reviews.length || snapshot.claims.length > 32)) invalid();
    if (claimsOnly) {
      const cursor = Number(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='lapsed_claim_scan_cursor'").get()?.meta_value ?? 0);
      if (!Number.isSafeInteger(snapshot.claimScan?.previous) || snapshot.claimScan.previous < 0
        || !Number.isSafeInteger(snapshot.claimScan?.next) || snapshot.claimScan.next <= 0) invalid();
      if (snapshot.claimScan.previous !== cursor) changed();
    }
    const plan = claimsOnly ? { holdWarnings: [], holdExpiries: [], reviewReleases: [] } : planStaleState(snapshot);
    const result = { warnings: [], holds: [], reviews: [] };
    /** Use the existing sentinel channel and direct recipient; item routing would replace the holder address. */
    // The sentinel is no seat, so each notice records the model of the seat whose maintenance sent it.
    const model = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_model:${agentId}`)?.meta_value ?? 'unknown';
    const notice = (to, text, item) => insertShout(board, { from: 'sentinel', to, text, lanes: [], detail: { item, model } });
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
        ...((board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_REASONS_ENGINE ? { reasonCode: 'OTHER' } : {}),
        stale: { reviewer: row.reviewer, reservedAt: row.reservedAt, lastActivity: row.lastActivity } });
      notice(row.reviewer, `Released your idle review reservation on #${row.id}: ${reason} The item is available for independent review.`, row.id);
      result.reviews.push(row.id);
    }
    if (claimsOnly) {
      // Validate the complete batch against one event prefix before the first release appends another event.
      const idleRows = snapshot.claims.filter(row => row.idle !== undefined);
      if (idleRows.length && (board.executionEngineVersion ?? ENGINE_VERSION) < CLAIM_IDLE_ENGINE) throw new Refused('ENGINE_VERSION', 'upgrade before automatic idle-claim release');
      const idle = idleRows.map(row => idleClaim(board, row, snapshot, agentId, itemById));
      const claims = snapshot.claims.filter(row => row.idle === undefined).map(row => {
        const item = itemById(board, row.id);
        const lease = board.db.prepare("SELECT event_id,event_at,event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind IN ('claim','renew') ORDER BY event_id DESC LIMIT 1").get(row.id, row.actor);
        const leaseMs = Date.parse(item.item_lease_until) - Date.parse(lease?.event_at);
        if (!lease || item.item_status !== 'claimed' || item.item_owner !== row.actor || item.item_owner === agentId
          || item.item_lease_until !== row.leaseUntil || lease?.event_id !== row.leaseEventId
          || lease?.event_at !== row.leaseStartedAt || JSON.parse(lease.event_detail).leaseUntil !== row.leaseUntil
          || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || row.leaseMs !== leaseMs) changed();
        observedExpiry(row, snapshot.limits.claim, snapshot.observedAt);
        const leaseAt = staleInstant(row.leaseUntil, Date.parse(snapshot.observedAt));
        if (leaseAt === null || Date.parse(snapshot.observedAt) - leaseAt < snapshot.limits.claim) invalid();
        return { row, item, leaseMs };
      });
      result.claims = [];
      board.db.prepare("INSERT INTO board_meta(meta_key,meta_value) VALUES('lapsed_claim_scan_cursor',?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value").run(String(snapshot.claimScan.next));
      result.claimScan = snapshot.claimScan;
      for (const { row, item, leaseMs } of claims) {
        const window = { builder: item.item_owner, until: new Date(board.clock.now().getTime() + leaseMs).toISOString() };
        moveItem(board, row.id, 'release', {
          checks: { joined: null, [IN_STATE]: null, releaseOwnsWork: () => null, reviewReleaseExplained: null },
          set: () => ({ item_owner: null, item_lease_until: null }),
        });
        logEvent(board, agentId, 'release', row.id, { reason: 'Lapsed claim idle past its stale interval.',
          ...((board.executionEngineVersion ?? ENGINE_VERSION) >= RELEASE_REASONS_ENGINE ? { reasonCode: 'OTHER' } : {}),
          expiredClaim: { holder: row.actor, leaseUntil: row.leaseUntil, lastActivity: row.lastActivity, observedAt: snapshot.observedAt, leaseEventId: row.leaseEventId },
          reopenFirstRefusal: window });
        notice(row.actor, `Your lapsed idle claim on #${row.id} returned to open; first refusal remains yours until ${window.until}.`, row.id);
        result.claims.push(row.id);
      }
      for (const { row, item } of idle) {
        if (row.idle === 'stall') {
          // Told once per claim episode: the holder's lane lead, or the coordinator when the lane has none.
          board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(`claim_stalled:${row.id}`, String(row.episodeEventId));
          const minutes = Math.floor(row.idleMs / 60_000);
          logEvent(board, agentId, 'claim_stalled', row.id, { holder: row.actor, lastActivity: row.workActivity, idleMinutes: minutes, observedAt: snapshot.observedAt });
          notice(laneLead(board, item.item_lane), `#${row.id} (${row.actor}) is stalled: no commit, file change, running check or item move for ${minutes} minutes; it is released automatically at 40.`, row.id);
          (result.stalled ??= []).push(row.id);
          continue;
        }
        const reason = row.idle === 'dependency'
          ? `Stale dependency: no commit, test run or fact since ${row.workActivity}, past health.dependencyIdle; ${handoffText(row.handoff)}.`
          : row.idle === 'seat-gone'
          ? `Seat ${row.actor} has no heartbeat for two minutes or its worktree is gone; claim returned to the queue.`
          : row.idle === 'progress'
          ? `Returned after ${row.progress.trigger}; holder ${row.actor}'s notes: ${row.progress.notes.join(', ') || 'none recorded'} (pullboard show ${row.id} --detail); ${handoffText(row.handoff)}.`
          : row.idle === 'waiting'
          ? `Waiting on ${row.waitingOn.map(id => `#${id}`).join(', ')}, which has not landed; the item returns to the queue when it lands.`
          : `Idle ${Math.floor(row.idleMs / 60_000)} minutes: no commit, file change, running check or item move since ${row.workActivity}; ${handoffText(row.handoff)}.`;
        moveItem(board, row.id, 'release', {
          checks: { joined: null, [IN_STATE]: null, releaseOwnsWork: () => null, reviewReleaseExplained: null },
          set: () => ({ item_owner: null, item_lease_until: null }),
        });
        if (row.idle === 'progress') logEvent(board, 'board', 'fact', row.id, {
          id: `progress-return-${row.id}-${row.claimEventId}`, kind: 'note', text: reason, ref: null, supersedes: null });
        logEvent(board, agentId, 'release', row.id, { reason,
          ...(row.idle === 'seat-gone' ? { reclaim: { seat: row.actor, heartbeatAt: row.deadSeat.heartbeatAt, worktreeMissing: row.deadSeat.worktreeMissing,
            observedAt: snapshot.observedAt } } : {}),
          ...(row.idle === 'progress' ? { reopenFirstRefusal: { builder: row.actor, otherSeatFirst: true, until: new Date(Date.parse(snapshot.observedAt) + 7_200_000).toISOString() } } : {}), reasonCode: row.idle === 'waiting' ? 'BLOCKED' : 'OTHER',
          idleClaim: { holder: row.actor, kind: row.idle, lastActivity: row.workActivity ?? null, observedAt: snapshot.observedAt, claimEventId: row.claimEventId,
            ...(row.idle === 'waiting' ? { waitingOn: row.waitingOn } : { handoff: row.handoff }) } });
        board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(`claim_stalled:${row.id}`);
        if (row.idle === 'waiting') board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(`claim_waiting:${row.id}`, JSON.stringify(row.waitingOn));
        notice(row.actor, `Released your claim on #${row.id}: ${reason}`, row.id);
        if (row.idle === 'dependency') for (const dependent of dependencyWaiters(board, row.id)) {
          notice(dependent.item_owner ?? laneLead(board, dependent.item_lane), `Dependency #${row.id} of #${dependent.item_id} was released as stale and is available again at its rank; a new builder can claim it.`, dependent.item_id);
        }
        result.claims.push(row.id);
      }
    }
    // A scan that found nothing and moved nothing is not a board event: with a seat command every few seconds, the
    // empty record was written 3,609 times on 6 Nov, each one a board write every reader waited behind [C7].
    const scanned = result.claimScan && result.claimScan.previous !== result.claimScan.next;
    if (result.warnings.length || result.holds.length || result.reviews.length || result.claims?.length || result.stalled?.length || scanned) {
      logEvent(board, agentId, 'stale_maintenance', null, { observedAt: snapshot.observedAt, ...result });
    }
    return result;
  });
}
