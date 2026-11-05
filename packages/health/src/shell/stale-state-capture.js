import { CLAIM_PROGRESS_ENGINE } from '../../../state/index.js';
import { CLAIM_RETURNS_ENGINE } from '../../../state/index.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { staleInstant } from '../../../../src/board-stale-state-policy.js';
import { staleStateLimits } from '../../../../src/board-stale-state-policy.js';
/** Native maintenance captures local inputs once, before sending a replay-independent observation [B4,H16]. */
import { staleStateSnapshot } from './stale-state-snapshot.js';
import { observeStaleWork } from './stale-work-observation.js';
import { releaseBlockingItems } from '../core/stale-state-blockers.js';
import { CLAIM_STALL_MS } from '../core/stale-state-query.js';
import { CLAIM_IDLE_RELEASE_MS } from '../core/stale-state-query.js';
import { CLAIM_RECENT_COMMIT_MS } from '../core/stale-state-query.js';
import { cleanGitEnvironment } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { existsSync } from 'node:fs';
import { claimFolderActive } from './claim-folder-activity.js';
import { redReturnLeaseHolds } from '../../../store/index.js';
import { submitGateInFlight } from '../../../store/index.js';
import { itemPinned } from '../../../store/index.js';
import { PINNED_CLAIM_RELEASE_MS } from '../../../store/index.js';
import { PINNED_CLAIM_LAPSE_ENGINE } from '../../../../src/pinned-claim-lapse-engine.js';

/** Capture main-red evidence only on the write maintenance path, retaining fast read-only status. */
export async function captureStaleState(ctx, board) {
  const blockers = releaseBlockingItems(board);
  const { mainRedReworkItems } = await import('../../../landing/index.js');
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
export function pinClaimHandoff(board, row, item) {
  const unpinned = why => ({ head: null, pin: null, changedFiles: [], changedCount: 0, unpinned: why });
  const seat = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(row.actor);
  if (!seat?.agent_path) return unpinned('the seat has no registered worktree');
  const env = cleanGitEnvironment();
  const head = tryGit(seat.agent_path, ['rev-parse', '--verify', 'HEAD^{commit}'], { env });
  if (head.status !== 0) return unpinned('the seat worktree has no readable commit');
  const commit = head.stdout.trim();
  const pin = `refs/pullboard/handoffs/${row.id}/${commit.slice(0, 12)}`;
  if (tryGit(seat.agent_path, ['update-ref', pin, commit], { env }).status !== 0) return unpinned(`the board ref for ${commit.slice(0, 12)} could not be written`);
  const base = /^[0-9a-f]{40,64}$/u.test(item.item_claim_head ?? '') ? item.item_claim_head : null;
  const committed = base ? tryGit(seat.agent_path, ['diff', '--name-only', '--no-renames', base, commit], { env }) : { status: 0, stdout: '' };
  const dirty = tryGit(seat.agent_path, ['status', '--porcelain', '--untracked-files=all'], { env });
  const all = committed.status === 0 && dirty.status === 0
    ? [...new Set([...committed.stdout.split('\n'), ...dirty.stdout.split('\n').map(line => line.slice(3))].filter(Boolean))].sort() : [];
  return { head: commit, pin, changedFiles: all.slice(0, HANDOFF_FILES), changedCount: all.length,
    uncommitted: dirty.status === 0 ? dirty.stdout.split('\n').filter(Boolean).length : null };
}

/**
 * Every live claim one write observes (#1225): all of them, every pass, so no claim can wait on its place in a scan.
 * Each costs one row and one worktree read; only a measured pass over 1 s would justify a cursor that advances
 * every pass, never a time-based window.
 */
function liveClaims(board, actor) {
  return board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner<>? ORDER BY item_id").all(actor);
}

/** Whether the holder committed within the last 30 minutes, which the progress rule never overrides (#2251). */
function recentCommit(row, now) {
  const at = row.commitAt ? Date.parse(row.commitAt) : NaN;
  return Number.isFinite(at) && now - at < CLAIM_RECENT_COMMIT_MS;
}

/**
 * Capture at most 32 claims before an ordinary write: claims idle past their lapsed lease (#1933), and, since #1225, live
 * claims with no real work for 20 minutes (stalled, told once) or 40 (released with a handoff), and claims waiting on
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
  const otherClaims = liveClaims(board, actor).filter(item => !lapsed.has(item.item_id));
  items.push(...otherClaims);
  if (!items.length) return null;
  // A seat whose worktree no longer exists can do no work there, so it reads as idle rather than unknown (#1225 row 7).
  const gone = holder => { const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(holder)?.agent_path; return Boolean(path) && !existsSync(path); };
  const snapshot = staleStateSnapshot(board, ctx.config, { now: at, items, claimsOnly: true, blocker: () => false,
    // Lapsed rows read seat presence only; the write path's guard keeps Git out even if that ever changed.
    workObservation: holder => gone(holder) ? { available: true, at: null } : lapsedOnly ? { available: false, at: null } : observeStaleWork(board, holder) });
  const lapsedItems = items.filter(item => lapsed.has(item.item_id));
  snapshot.claimScan = { previous: cursor, next: lapsedItems.length ? lapsedItems.at(-1).item_id : Math.max(cursor, 1) };
  const byId = new Map(items.map(item => [item.item_id, item]));
  snapshot.claims = snapshot.claims.flatMap(row => {
    // A queued or running gate is the holder's activity; neither the lapsed-lease sweep nor the idle release takes it (#2561).
    if (submitGateInFlight(board, byId.get(row.id))) return [];
    // A red queued gate's fresh lease is the builder's to use; idle maintenance waits for it to end (#2454).
    if (!lapsed.has(row.id) && redReturnLeaseHolds(board, byId.get(row.id), at.getTime())) return [];
    const path = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(row.actor)?.agent_path;
    const worktreeMissing = !path || !existsSync(path);
    // Any event the seat itself wrote is a sign of life: a seat without hooks runs reads, tests and other board
    // commands between heartbeats, and a busy presence file can miss a beat. On 4 Nov 412 of 415 seat-gone
    // releases took claims from seats that had written an event within the previous two minutes.
    const lastHeartbeat = latestInstant(row.heartbeatAt ?? row.claimAt, seatActivityAt(board, row.actor));
    const heartbeatLost = Number.isFinite(Date.parse(lastHeartbeat ?? ''))
      && at.getTime() - Date.parse(lastHeartbeat) >= seatQuietLimit;
    // Seat silence is not worktree silence; even the Git-free write path observes native item edits.
    if (path && (heartbeatLost || worktreeMissing) && claimFolderActive(path, row.id, at.getTime()) !== false) return [];
    if (worktreeMissing || heartbeatLost) return [{ ...row, idle: 'seat-gone', deadSeat: { heartbeatAt: lastHeartbeat ?? row.heartbeatAt ?? null,
      worktreeMissing, observedAt: at.toISOString(), quietMs: seatQuietLimit } }];
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_PROGRESS_ENGINE && row.progress.trigger && row.health !== 'waiting'
      && (row.idleMs === null || row.idleMs < CLAIM_IDLE_RELEASE_MS)
      && !((board.executionEngineVersion ?? ENGINE_VERSION) >= CLAIM_RETURNS_ENGINE && recentCommit(row, at.getTime()))) {
      if (lapsedOnly) return [];
      return [{ ...row, idle: 'progress', handoff: pinClaimHandoff(board, row, byId.get(row.id)) }];
    }
    if (lapsed.has(row.id)) {
      return row.evidence.complete && row.expired && staleInstant(row.leaseUntil, at.getTime()) !== null
        && Number.isSafeInteger(row.leaseMs) && row.leaseMs > 0 ? [row] : [];
    }
    if (row.health === 'waiting') return [{ ...row, idle: 'waiting' }];
    if (row.idleMs === null || row.idleMs < CLAIM_STALL_MS) return [];
    // A pinned item blocks the coordinator's order, so its idle claim lapses after 30 minutes instead of 40.
    const pinnedLapse = (board.executionEngineVersion ?? ENGINE_VERSION) >= PINNED_CLAIM_LAPSE_ENGINE && itemPinned(board, row.id);
    if (row.idleMs >= (pinnedLapse ? PINNED_CLAIM_RELEASE_MS : CLAIM_IDLE_RELEASE_MS)) {
      // Nothing keeps a claim stalled past 40 minutes; the handoff says what was pinned, or why nothing could be.
      return [{ ...row, idle: 'release', handoff: pinClaimHandoff(board, row, byId.get(row.id)) }];
    }
    const told = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`claim_stalled:${row.id}`)?.meta_value;
    return told === String(row.episodeEventId) ? [] : [{ ...row, idle: 'stall' }];
  });
  // At most 32 decisions per write; any left over are taken by the next write.
  snapshot.claims = snapshot.claims.slice(0, 32);
  if (!snapshot.claims.length && !lapsedItems.length) return null;
  return snapshot;
}
