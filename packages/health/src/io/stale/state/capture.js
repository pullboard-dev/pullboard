import { dependencyCustodyQuiet } from '../../dependency.js';
import { STRANDED_DEPENDENCY_ENGINE } from '../../../../../state/index.js';
import { strandedDependency } from '../../dependency.js';
import { observeDependencyWork } from '../../dependency.js';
import { CLAIM_PROGRESS_ENGINE } from '../../../../../state/index.js';
import { CLAIM_RETURNS_ENGINE } from '../../../../../state/index.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
import { staleInstant } from '../../../../../store/index.js';
import { staleStateLimits } from '../../../../../store/index.js';
/** Native maintenance captures local inputs once, before sending a replay-independent observation [B4,H16]. */
import { staleStateSnapshot } from './snapshot.js';
import { observeStaleWork } from '../observation/work.js';
import { releaseBlockingItems } from '../../../logic/stale/state/blockers.js';
import { CLAIM_STALL_MS } from '../../../logic/stale/state/query.js';
import { CLAIM_IDLE_RELEASE_MS } from '../../../logic/stale/state/query.js';
import { CLAIM_RECENT_COMMIT_MS } from '../../../logic/stale/state/query.js';
import { RENEWALS } from '../../../logic/stale/state/query.js';
import { cleanGitEnvironment } from '../../../../../git/index.js';
import { tryGit } from '../../../../../git/index.js';
import { fileSystemAdapter } from '../../../../../fs/index.js';
import { claimKeepWhileRunning } from '../../../../../config/index.js';
import { machineStalled } from '../../../logic/stall.js';
import { claimFolderActive } from '../../claim/activity.js';
import { claimFolderCommitAt } from '../../claim/activity.js';
import { redReturnLeaseHolds } from '../../../../../store/index.js';
import { itemWorkInFlight } from '../../../../../store/index.js';
import { itemPinned } from '../../../../../store/index.js';
import { PINNED_CLAIM_RELEASE_MS } from '../../../../../store/index.js';
import { PINNED_CLAIM_LAPSE_ENGINE } from '../../../../../state/light.js';

const fs = fileSystemAdapter();

/** Capture main-red evidence only on the write maintenance path, retaining fast read-only status. */
export async function captureStaleState(ctx, board) {
  const blockers = releaseBlockingItems(board);
  const { mainRedReworkItems } = await import('../../../../../landing/index.js');
  for (const id of mainRedReworkItems(ctx.info.root, board)) blockers.add(id);
  return staleStateSnapshot(board, ctx.config, { now: ctx.clock.now(), blocker: item => blockers.has(item.item_id),
    workObservation: actor => observeStaleWork(board, actor) });
}

/** The most changed files a handoff names; the rest are counted, so a large change never blocks its release. */
const HANDOFF_FILES = 200;

/**
 * Pin the holder's last commit to a board ref and list the files its claim changed, so a released claim keeps its
 * work. A worktree that cannot be read still releases (#1225 row 7): the handoff then says why nothing was pinned.
 */
export function pinClaimHandoff(board, row, item, workRoot = null) {
  const unpinned = why => ({ head: null, pin: null, changedFiles: [], changedCount: 0, unpinned: why });
  const seat = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(row.actor);
  if (!seat?.agent_path) return unpinned('the seat has no registered worktree');
  const root = workRoot ?? seat.agent_path;
  const env = cleanGitEnvironment();
  const head = tryGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { env });
  if (head.status !== 0) return unpinned('the seat worktree has no readable commit');
  const commit = head.stdout.trim();
  const pin = `refs/pullboard/handoffs/${row.id}/${commit.slice(0, 12)}`;
  if (tryGit(root, ['update-ref', pin, commit], { env }).status !== 0) return unpinned(`the board ref for ${commit.slice(0, 12)} could not be written`);
  const base = /^[0-9a-f]{40,64}$/u.test(item.item_claim_head ?? '') ? item.item_claim_head : null;
  const committed = base ? tryGit(root, ['diff', '--name-only', '--no-renames', base, commit], { env }) : { status: 0, stdout: '' };
  const dirty = tryGit(root, ['status', '--porcelain', '--untracked-files=all'], { env });
  const all = committed.status === 0 && dirty.status === 0
    ? [...new Set([...committed.stdout.split('\n'), ...dirty.stdout.split('\n').map(line => line.slice(3))].filter(Boolean))].sort() : [];
  return { head: commit, pin, changedFiles: all.slice(0, HANDOFF_FILES), changedCount: all.length,
    uncommitted: dirty.status === 0 ? dirty.stdout.split('\n').filter(Boolean).length : null };
}

/**
 * Claims with an unexpired or unknown lease are considered on every background pass (#1225). Expired leases stay in
 * the bounded cursor scan so an item beyond its current page cannot bypass the cursor.
 */
function liveClaims(board, actor, cutoff) {
  return board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner<>? AND (item_lease_until IS NULL OR item_lease_until>?) ORDER BY item_id").all(actor, cutoff);
}

/** Whether the holder committed within the last 30 minutes, which the progress rule never overrides (#2251). */
function recentCommit(row, now) {
  const at = row.commitAt ? Date.parse(row.commitAt) : NaN;
  return Number.isFinite(at) && now - at < CLAIM_RECENT_COMMIT_MS;
}

/**
 * Capture at most 32 claims before an ordinary write: claims idle past their lapsed lease (#1933), and, since #1225, live
 * claims with no real work for 20 minutes (stalled, told once) or 30 (released with a handoff), and claims waiting on
 * an item that has not landed. Incomplete activity evidence stays unknown and never releases anything.
 * `lapsedOnly` is the write path's share (#2427): only claims whose lease has already lapsed, which read board rows and
 * seat presence and never run Git. Live claims, and returns that pin a handoff, wait for background maintenance.
 */
/** The latest event this seat wrote, or null; the board's own record that the seat is still running commands. */
function seatActivityAt(board, seat) {
  try { return board.db.prepare('SELECT max(event_at) AS at FROM event WHERE event_by=?').get(seat)?.at ?? null; }
  catch { return null; }
}

/** The later of two ISO instants, either of which may be missing. */
function latestInstant(first, second) {
  const a = Date.parse(first ?? ''), b = Date.parse(second ?? '');
  if (!Number.isFinite(b)) return first;
  if (!Number.isFinite(a)) return second;
  return b > a ? second : first;
}

/**
 * The holder's last real work on a lapsed claim: its claim episode's start, its latest non-renewal move on the item
 * (proof runs and facts included) and its latest commit in the item folder. Heartbeats, shouts and renewals are
 * presence, never progress (#3446). Null when the episode start is unknown.
 */
function lapsedWorkAt(board, row, path, now) {
  const episode = board.db.prepare('SELECT event_at FROM event WHERE event_id=?').get(row.episodeEventId)?.event_at;
  if (staleInstant(episode, now) === null) return null;
  const move = board.db.prepare(`SELECT event_at FROM event WHERE event_by=? AND item_id=? AND event_kind NOT IN (${RENEWALS}) ORDER BY event_id DESC LIMIT 1`).get(row.actor, row.id)?.event_at;
  const commit = path ? claimFolderCommitAt(path, row.id, now) : null;
  const known = [episode, move, commit].filter(value => staleInstant(value, now) !== null);
  return new Date(Math.max(...known.map(Date.parse))).toISOString();
}

/** How long a test run or check may wait for a runner and still count as its holder's work in flight. */
const JOB_QUEUE_MS = 15 * 60_000;

/**
 * Whether the claim has a test run or runner check in flight on the board: a test-run, test or gate job on the item
 * whose worker or runner holds a live lease, or one queued in the last 15 minutes that no runner has taken yet. A
 * test run counts only when its holder queued it; a check counts only when it started after this claim.
 * Why: a holder waiting on a 3-10 minute runner run beats no heartbeat, and 68 claims were taken as seat-gone on
 * 12 Nov while their runs were live (#6128). The lease is the liveness: a dead runner stops renewing it, and the
 * claim becomes sweepable again. One indexed read per quiet claim, so it stays cheap in stale capture.
 */
function claimJobInFlight(board, item, claimAt, now) {
  if (!item?.item_owner) return false;
  const since = Date.parse(claimAt ?? '');
  let rows;
  try {
    rows = board.db.prepare(`SELECT j.job_kind AS kind, j.job_created AS created,
      (SELECT s.job_step_payload FROM job_step s WHERE s.job_step_job = j.job_id AND s.job_step_name = 'queued' ORDER BY s.job_step_id LIMIT 1) AS queued
      FROM job j WHERE j.job_kind IN ('test-run', 'test', 'gate') AND j.job_item = ?
      AND (j.job_lease_until > ? OR (j.job_lease_owner IS NULL AND j.job_step IN ('queued', 'offered') AND j.job_created > ?))`)
      .all(item.item_id, now, now - JOB_QUEUE_MS);
  } catch { return false; } // an older board has no job tables, so it holds no run
  return rows.some(row => {
    if (row.kind !== 'test-run') return !Number.isFinite(since) || row.created >= since;
    try { return JSON.parse(row.queued ?? '{}').agent === item.item_owner; } catch { return false; }
  });
}

/**
 * Every item id an open or claimed item waits on, from one read of the item table: the same comma-delimited membership the
 * items cell's per-id dependents query matches, read once per pass instead of once per claim row [C7,#11998].
 * Why: that query scans the whole item table, so a pass over 240 claims on an 11,994-item board spent 16 s before every write.
 *
 * @param {any} board
 * @returns {Set<string>} The waited-on ids, as strings.
 */
export function dependencyWaitedIds(board) {
  const waited = new Set();
  for (const { item_after: after } of board.db.prepare("SELECT item_after FROM item WHERE item_status IN ('open','claimed') AND item_after<>''").all()) {
    for (const id of String(after).split(',')) waited.add(id);
  }
  return waited;
}

/**
 * Capture the claims whose lease has lapsed, or whose holder has gone quiet, as one stale-state snapshot for the sweep to act on.
 *
 * @param {object} ctx
 * @param {object} board
 * @param {string} actor
 * @param {{lapsedOnly?: boolean}} [options]
 * @returns {object|null}
 */
export function captureLapsedClaims(ctx, board, actor, { lapsedOnly = false } = {}) {
  const at = ctx.clock.now();
  const seatQuietLimit = 2 * 60_000;
  const limit = staleStateLimits(ctx.config).claim;
  const cutoff = new Date(at.getTime() - limit).toISOString();
  const previous = Number(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='lapsed_claim_scan_cursor'").get()?.meta_value ?? 0);
  const cursor = Number.isSafeInteger(previous) && previous >= 0 ? previous : 0;
  const items = board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner<>? AND item_lease_until<=? AND item_id>? ORDER BY item_id LIMIT 32").all(actor, cutoff, cursor);
  if (items.length < 32) items.push(...board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner<>? AND item_lease_until<=? AND item_id<=? ORDER BY item_id LIMIT ?").all(actor, cutoff, cursor, 32 - items.length));
  const lapsed = new Set(items.map(item => item.item_id));
  const otherClaims = liveClaims(board, actor, cutoff).filter(item => !lapsed.has(item.item_id));
  items.push(...otherClaims);
  if (!items.length) return null;
  // A seat whose worktree no longer exists can do no work there, so it reads as idle rather than unknown (#1225 row 7).
  const gone = holder => { const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(holder)?.agent_path; return Boolean(path) && !fs.exists(path); };
  const snapshot = staleStateSnapshot(board, ctx.config, { now: at, items, claimsOnly: true, blocker: () => false,
    // Lapsed rows read seat presence only; the write path's guard keeps Git out even if that ever changed.
    workObservation: holder => gone(holder) ? { available: true, at: null } : lapsedOnly ? { available: false, at: null } : observeStaleWork(board, holder) });
  const lapsedItems = items.filter(item => lapsed.has(item.item_id));
  snapshot.claimScan = { previous: cursor, next: lapsedItems.length ? lapsedItems.at(-1).item_id : Math.max(cursor, 1) };
  const byId = new Map(items.map(item => [item.item_id, item]));
  const keepWhileRunning = ctx.keepClaimWhileRunning ?? claimKeepWhileRunning();
  /** A seat is quiet when neither its heartbeat nor any event it wrote is two minutes old. */
  const quietSeat = row => {
    const beat = latestInstant(row.heartbeatAt ?? row.claimAt, seatActivityAt(board, row.actor));
    return Number.isFinite(Date.parse(beat ?? '')) && at.getTime() - Date.parse(beat) >= seatQuietLimit;
  };
  // Most claimed seats going quiet in the same window is the machine stalling, not those seats dying (8 Nov: 21 releases
  // in 3 h clustered with a coordinator stall): no claim is released for this window, and one shout says so.
  const stall = machineStalled({ claimed: snapshot.claims.length, quiet: snapshot.claims.filter(quietSeat).length, gapMs: ctx.sweepGapMs ?? 0 });
  if (stall) ctx.machineStall = { ...stall, observedAt: at.toISOString() };
  // The waited-on ids are read once, at the first row that needs them, never once per claim row [C7,#11998].
  let waited = null;
  snapshot.claims = snapshot.claims.flatMap(row => {
    // A queued or running gate or proof run is the holder's activity; neither the lapsed-lease sweep nor the idle release takes it (#2561).
    if (itemWorkInFlight(board, byId.get(row.id))) return [];
    // With claim.keepWhileRunning on, a live test run, test or gate job on the item keeps the claim whatever the seat's heartbeat or idle time says [C7,#9498].
    if (keepWhileRunning && claimJobInFlight(board, byId.get(row.id), row.claimAt, at.getTime())) return [];
    const dependencyCandidate = (board.executionEngineVersion ?? ENGINE_VERSION) >= STRANDED_DEPENDENCY_ENGINE && (waited ??= dependencyWaitedIds(board)).has(String(row.id));
    if (dependencyCandidate && !dependencyCustodyQuiet(board, byId.get(row.id))) return [];
    // A red queued gate's fresh lease is the builder's to use; idle maintenance waits for it to end (#2454).
    if (!lapsed.has(row.id) && redReturnLeaseHolds(board, byId.get(row.id), at.getTime())) return [];
    const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(row.actor)?.agent_path;
    const worktreeMissing = !path || !fs.exists(path);
    // Any event the seat itself wrote is a sign of life: a seat without hooks runs reads, tests and other board
    // commands between heartbeats, and a busy presence file can miss a beat. On 4 Nov 412 of 415 seat-gone
    // releases took claims from seats that had written an event within the previous two minutes.
    const lastHeartbeat = latestInstant(row.heartbeatAt ?? row.claimAt, seatActivityAt(board, row.actor));
    const heartbeatLost = Number.isFinite(Date.parse(lastHeartbeat ?? ''))
      && at.getTime() - Date.parse(lastHeartbeat) >= seatQuietLimit;
    // A quiet seat waiting on its own test run or check is working; only a seat with nothing in flight is gone (#6128).
    if (heartbeatLost && !worktreeMissing && claimJobInFlight(board, byId.get(row.id), row.claimAt, at.getTime())) return [];
    // Seat silence is not worktree silence; even the Git-free write path observes native item edits.
    if (stall && heartbeatLost) return [];
    if (path && (heartbeatLost || worktreeMissing) && claimFolderActive(path, row.id, at.getTime()) !== false) return [];
    // Presence is not progress (#3446): a lease lapsed 30 minutes ago returns once the holder has made no move, commit
    // or proof run on it for 30 minutes, however often the seat heartbeats. Pinning its handoff runs Git, so the
    // write path leaves it to background maintenance. A claim waiting on an unlanded item keeps its own rule.
    const leaseAt = staleInstant(row.leaseUntil, at.getTime());
    if (!heartbeatLost && row.health !== 'waiting' && leaseAt !== null && at.getTime() - leaseAt >= CLAIM_IDLE_RELEASE_MS) {
      if (lapsedOnly) return [];
      const workActivity = lapsedWorkAt(board, row, path, at.getTime());
      const idleMs = workActivity === null ? null : at.getTime() - Date.parse(workActivity);
      if (idleMs === null || idleMs < CLAIM_IDLE_RELEASE_MS) return [];
      return [{ ...row, idle: 'release', workActivity, idleMs, handoff: pinClaimHandoff(board, row, byId.get(row.id)) }];
    }
    // An expired lease follows the lease-lapse path only after a quiet heartbeat; a live seat still vetoes expiry.
    if (lapsed.has(row.id)) {
      if (!heartbeatLost) return [];
      return row.evidence.complete && row.expired && staleInstant(row.leaseUntil, at.getTime()) !== null
        && Number.isSafeInteger(row.leaseMs) && row.leaseMs > 0 ? [row] : [];
    }
    if (heartbeatLost) return [{ ...row, idle: 'seat-gone', deadSeat: { heartbeatAt: lastHeartbeat ?? row.heartbeatAt ?? null,
      worktreeMissing, observedAt: at.toISOString(), quietMs: seatQuietLimit } }];
    if (!lapsedOnly && dependencyCandidate) {
      const item = byId.get(row.id);
      const work = observeDependencyWork(board, item);
      if (!work) return [];
      const dependency = strandedDependency(board, item, row, at.getTime(), snapshot.limits.dependency, work);
      if (dependency) return [{ ...dependency, handoff: pinClaimHandoff(board, dependency, item, dependency.workRoot) }];
      // A measured dependency has its own configured interval; generic forty-minute idle expiry cannot shorten it.
      return [];
    }
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_PROGRESS_ENGINE && row.progress.trigger && row.health !== 'waiting'
      && (row.idleMs === null || row.idleMs < CLAIM_IDLE_RELEASE_MS)
      && !((board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_RETURNS_ENGINE && recentCommit(row, at.getTime()))) {
      if (lapsedOnly) return [];
      return [{ ...row, idle: 'progress', handoff: pinClaimHandoff(board, row, byId.get(row.id)) }];
    }
    // A live seat's claim waiting on an unlanded item is returned by background maintenance, never by another seat's write.
    if (row.health === 'waiting') return lapsedOnly ? [] : [{ ...row, idle: 'waiting' }];
    if (row.idleMs === null || row.idleMs < CLAIM_STALL_MS) return [];
    // A pinned item blocks the coordinator's order, so its idle claim lapses after 30 minutes instead of 40.
    const pinnedLapse = (board.executionEngineVersion ?? ENGINE_VERSION) >= PINNED_CLAIM_LAPSE_ENGINE && itemPinned(board, row.id);
    if (row.idleMs >= (pinnedLapse ? PINNED_CLAIM_RELEASE_MS : CLAIM_IDLE_RELEASE_MS)) {
      // Nothing keeps a claim stalled past 30 minutes; the handoff says what was pinned, or why nothing could be.
      return [{ ...row, idle: 'release', handoff: pinClaimHandoff(board, row, byId.get(row.id)) }];
    }
    const told = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`claim_stalled:${row.id}`)?.meta_value;
    return told === String(row.episodeEventId) ? [] : [{ ...row, idle: 'stall' }];
  });
  // At most 32 decisions per write; any left over are taken by the next write.
  snapshot.claims = snapshot.claims.slice(0, 32);
  if (!snapshot.claims.length && !lapsedItems.length) return null;
  // Every lapsed claim was kept and the scan cursor stays put: the maintenance write would change nothing, yet it took
  // the board's write lock before every command (44.6% of live writes on 18 Nov), so none is opened [C7,#10875].
  if (!snapshot.claims.length && snapshot.claimScan.next === snapshot.claimScan.previous) return null;
  return snapshot;
}
