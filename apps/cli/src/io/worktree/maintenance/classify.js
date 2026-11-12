import { maintenanceProtectedPath } from './protection.js';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const FINISHED_IDLE_MS = 2 * 60 * 60 * 1000;
const DURATION = /^(\d+)(ms|s|m|h|d)$/u;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: DAY_MS };

/** Normalize an absolute path without following symlinks, so classification is deterministic from Git metadata. */
function absolutePath(value) {
  return typeof value === 'string' && value.length ? resolve(value) : null;
}

/** Check path containment by components rather than string prefixes, which confuse sibling names. */
function containsPath(parent, child) {
  if (!parent || !child) return false;
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Test whether two roots overlap; deleting a worktree ancestor could otherwise remove a protected child. */
function overlapsPath(left, right) {
  return containsPath(left, right) || containsPath(right, left);
}

/** Parse the validated maintenance grace setting, defaulting to one day for older configuration files. */
function graceMilliseconds(config) {
  const value = config?.worktreeMaintenance?.grace ?? '1d';
  const match = DURATION.exec(String(value));
  const milliseconds = match ? Number(match[1]) * UNIT_MS[match[2]] : NaN;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

/** Read a native or persisted timestamp without accepting invalid or future values as elapsed time. */
function timestamp(value) {
  const milliseconds = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

/** Return the newest actual timestamp supplied for a seat; a recent heartbeat must override old creation time. */
function seatActivity(seat) {
  const values = [seat.completedTakeoverAt, seat.goneAt, seat.lastNativeActivityAt, seat.heartbeatAt, seat.createdAt, seat.agent_created_at]
    .map(timestamp).filter(value => value !== null);
  return values.length ? Math.max(...values) : null;
}

/** Resolve configured worktree placement and test whether this registered tree is in that exact root. */
function expectedWorktreeRoot(treePath, mainRoot, placement) {
  if (!treePath || !mainRoot || !['inside', 'beside'].includes(placement)) return false;
  if (placement === 'inside') {
    const root = join(mainRoot, '.claude', 'worktrees');
    return treePath !== root && containsPath(root, treePath);
  }
  const parent = dirname(mainRoot), name = basename(mainRoot), treeName = basename(treePath);
  return dirname(treePath) === parent && treeName.startsWith(`${name}-`) && treeName.length > name.length + 1;
}

/** Match a reported process working directory to this tree without treating a similarly named sibling as inside it. */
function processInTree(processes, treePath) {
  if (!Array.isArray(processes)) return { unknown: true, matched: false };
  for (const process of processes) {
    const cwd = absolutePath(typeof process === 'string' ? process : process?.cwd ?? process?.path);
    if (!cwd) return { unknown: true, matched: false };
    if (containsPath(treePath, cwd)) return { unknown: false, matched: true };
  }
  return { unknown: false, matched: false };
}

/** A closed native item has either landed or been explicitly withdrawn. */
function itemClosed(item) {
  return Boolean(item.item_merged_commit) || item.item_status === 'withdrawn' || Boolean(item.item_withdrawn_reason);
}

/** A hand-made worktree is provably finished when its head is the recorded commit of an item that has landed or been withdrawn and holds no obligation (#5733). */
function provenFinished(head, items, now) {
  return typeof head === 'string' && head.length > 0 && items.some(item => item.item_commit === head && itemClosed(item) && !itemObligation(item, now));
}

/** A live claim, review lease, or unmerged submitted/verified item keeps its owning tree protected. */
function itemObligation(item, now) {
  if (item.item_status === 'claimed') return 'claim';
  const reviewUntil = timestamp(item.item_review_until);
  if (item.item_review_by && reviewUntil !== null && reviewUntil > now) return 'review-reservation';
  if (['submitted', 'verified'].includes(item.item_status) && !itemClosed(item)) return 'unmerged-submission';
  return null;
}

/** Classify one registered Git worktree using only canonical board rows and prior sweep observations.
 * Conservative uncertainty stays protected because the caller may later archive or prune this tree.
 * @param {{ path?: string, head?: string, locked?: boolean, bare?: boolean }} tree
 * @param {{ mainRoot: string, currentRoot?: string, config?: object, seats?: object[], items?: object[], previous?: object|null, now?: number, workingDirectories?: (string|object)[]|null }} context
 * @returns {{ path: string, kind: 'active'|'finished'|'orphaned'|'scratch', protected: boolean, reason: string, agents: string[], items: (string|number)[], inactiveSince: number|null, oldEnough: boolean }}
 */
export function classifyMaintenanceTree(tree, {
  mainRoot, currentRoot, config = {}, seats = [], items = [], previous = null, now = Date.now(), workingDirectories = null,
} = {}) {
  const path = absolutePath(tree?.path);
  const main = absolutePath(mainRoot), current = absolutePath(currentRoot);
  const result = (kind, protectedTree, reason, agents = [], linkedItems = [], inactiveSince = null, oldEnough = false) => ({
    path: path ?? String(tree?.path ?? ''), kind, protected: protectedTree, reason,
    agents: [...new Set(agents)].sort(), items: [...new Set(linkedItems)].sort((a, b) => Number(a) - Number(b)),
    inactiveSince, oldEnough,
  });
  if (!path || !main || !Number.isFinite(now)) return result('active', true, 'path-or-clock-unknown');
  if (maintenanceProtectedPath(path)) return result('active', true, 'recovery-checkout');

  // Item folders are separate Git worktrees, but custody belongs to their registered parent seat.
  const itemSeat = Array.isArray(seats) ? seats.find(seat => {
    const root = absolutePath(seat.path ?? seat.agent_path);
    return root && path.startsWith(`${root}-item-`) && /^[1-9]\d*$/u.test(path.slice(root.length + 6));
  }) : null;
  const folderItem = itemSeat ? Number(path.slice(absolutePath(itemSeat.path ?? itemSeat.agent_path).length + 6)) : null;
  const folderClaim = Array.isArray(items) ? items.find(item => item.item_id === folderItem
    && (item.item_owner === itemSeat?.agent_id || item.item_built_by === itemSeat?.agent_id)
    && itemObligation(item, now)) : null;
  if (folderClaim) return result('active', true, 'item-folder-obligation', [itemSeat.agent_id], [folderItem]);
  // A seat's prepared spare (#5776) is the seat's own scratch: it follows the seat's retirement and is never a stray checkout.
  const matchingSeats = Array.isArray(seats) ? seats.filter(seat => {
    const root = absolutePath(seat.path ?? seat.agent_path);
    return root && (root === path || `${root}-spare` === path);
  }) : [];
  const agentIds = matchingSeats.map(seat => seat.agent_id).filter(id => typeof id === 'string' && id.length);
  const priorAgents = Array.isArray(previous?.agents) ? previous.agents.filter(id => typeof id === 'string') : [];
  const allAgentIds = [...new Set([...agentIds, ...priorAgents])];
  const linkedItems = Array.isArray(items) ? items.filter(item => allAgentIds.some(id =>
    item.item_owner === id || item.item_built_by === id || item.item_review_by === id)) : [];
  const itemIds = linkedItems.map(item => item.item_id).filter(id => id !== undefined && id !== null);
  const grace = graceMilliseconds(config);
  if (grace === null || !Array.isArray(seats) || !Array.isArray(items)) return result('active', true, 'board-or-grace-unknown', allAgentIds, itemIds);

  // A tree enclosing a protected checkout could remove it; a child worktree is a separate Git identity.
  if (containsPath(path, main)) return result('active', true, 'main-checkout', agentIds, itemIds);
  if (current && containsPath(path, current)) return result('active', true, 'current-checkout', agentIds, itemIds);
  if (tree?.locked) return result('active', true, 'git-worktree-locked', agentIds, itemIds);
  if (tree?.bare) return result('active', true, 'bare-repository', agentIds, itemIds);

  const excludes = config?.worktreeMaintenance?.exclude ?? [];
  if (!Array.isArray(excludes)) return result('active', true, 'exclusion-list-unknown', agentIds, itemIds);
  for (const excluded of excludes) {
    if (typeof excluded !== 'string' || !excluded.length) return result('active', true, 'exclusion-path-unknown', agentIds, itemIds);
    if (overlapsPath(resolve(main, excluded), path)) return result('active', true, 'configured-exclusion', agentIds, itemIds);
  }

  const processState = processInTree(workingDirectories, path);
  if (processState.unknown) return result('active', true, 'process-census-unknown', agentIds, itemIds);
  if (processState.matched) return result('active', true, 'process-working-directory', agentIds, itemIds);

  const outsideRoot = !expectedWorktreeRoot(path, main, config.worktrees ?? 'beside');
  if (config.worktrees === 'inside' && path === join(main, '.claude', 'worktrees')) {
    return result('active', true, 'worktree-container', agentIds, itemIds);
  }
  const activeItem = linkedItems.find(item => itemObligation(item, now));
  if (activeItem) return result('active', true, itemObligation(activeItem, now), agentIds, itemIds);

  let inactiveSince = timestamp(previous?.inactiveSince);
  for (const seat of matchingSeats) {
    // A joined seat keeps its checkout until a completed takeover retires it. Presence comes from hook heartbeats,
    // which a hookless, rejoined or pooled seat never refreshes, so "gone" never proves the seat has left (#5969).
    if (timestamp(seat.completedTakeoverAt) === null) {
      const reason = seat.presence === 'live' || seat.presence === 'idle' ? `seat-${seat.presence}` : 'seat-joined';
      return result('active', true, reason, agentIds, itemIds);
    }
    const activity = seatActivity(seat);
    if (activity === null) return result('active', true, 'seat-age-unknown', agentIds, itemIds);
    if (now < activity || now - activity < grace) return result('active', true, 'seat-recent-or-clock-rollback', agentIds, itemIds);
    inactiveSince = Math.max(inactiveSince ?? activity, activity);
  }

  const finishedProof = matchingSeats.length === 0 && !itemSeat && !outsideRoot && provenFinished(tree?.head, items, now);
  const closedWork = finishedProof || (linkedItems.length > 0 && linkedItems.every(itemClosed));
  const noSeatFirstSeen = matchingSeats.length === 0 ? timestamp(previous?.firstSeenAt) : null;
  if (inactiveSince === null) inactiveSince = noSeatFirstSeen ?? now;
  const elapsed = now - inactiveSince;
  const oldEnough = elapsed >= (finishedProof ? Math.min(grace, FINISHED_IDLE_MS) : grace);
  const kind = outsideRoot ? 'scratch' : closedWork ? 'finished' : 'orphaned';
  // Maintenance's own scratch area is a retired seat or a seat's item folder inside the configured worktree root;
  // a sibling checkout, a hand-made worktree or anything outside that root is someone else's and is never removed (#5969).
  // Only a hand-made tree provably finished (its head is a landed or withdrawn item's commit, #5733) leaves that protection.
  if (outsideRoot || (matchingSeats.length === 0 && !itemSeat && !finishedProof)) {
    return result(kind, true, 'outside-maintenance-scratch', agentIds, itemIds, inactiveSince, oldEnough);
  }
  return result(kind, false, closedWork ? 'all-linked-work-closed' : 'no-live-seat-or-work-claim', agentIds, itemIds, inactiveSince, oldEnough);
}
