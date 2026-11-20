/** Remove a seat, and its item folder, once its item has landed or been withdrawn and the tree is clean and idle [C7,#10783]. */
import { basename } from 'node:path';
import { resolve } from 'node:path';
import { maintenanceGit } from './archive.js';
import { itemObligation } from './classify.js';
import { maintenanceAllocatedBytes } from './observation.js';
import { takeMaintenanceCheckout } from './observation.js';

/** Classifier reasons that leave only a joined, idle or scratch tree; a claim, review, process, lock or exclusion never qualifies. */
const CANDIDATE_REASONS = new Set(['outside-maintenance-scratch', 'seat-joined', 'seat-idle', 'no-live-seat-or-work-claim', 'all-linked-work-closed']);
const ITEM_FOLDER = /-item-([1-9]\d*)$/u;

/** An item has landed (merged commit) or was withdrawn. */
function closed(item) {
  return Boolean(item.item_merged_commit) || item.item_status === 'withdrawn' || Boolean(item.item_withdrawn_reason);
}

/** A pool spare (`<seat>-spare`, `<seat>-spare-2`, or its item folder) is kept ready for the next builder and is never retired here. */
function spare(path) {
  return /-spare(?:[-.\d]|$)/u.test(basename(path));
}

/**
 * Which closed item lets this tree go, or null to keep it.
 * A seat folder goes when its seat built or owned a closed item; an item folder `<seat>-item-<n>` goes when item n is closed.
 * Either way, a live seat or any claim, review or unmerged submission held by the seat keeps it.
 */
function landedItem(path, { seats, items }, now) {
  const owners = seats.filter(seat => {
    const root = resolve(seat.agent_path ?? seat.path ?? '/');
    return root === path || ITEM_FOLDER.test(path) && path === `${root}-item-${ITEM_FOLDER.exec(path)[1]}`;
  });
  if (!owners.length || owners.some(seat => seat.presence === 'live')) return null;
  const ids = new Set(owners.map(seat => seat.agent_id));
  const mine = items.filter(item => ids.has(item.item_owner) || ids.has(item.item_built_by) || ids.has(item.item_review_by));
  if (mine.some(item => itemObligation(item, now))) return null;
  const folder = owners.some(seat => resolve(seat.agent_path ?? seat.path ?? '/') === path) ? null : Number(ITEM_FOLDER.exec(path)[1]);
  const done = folder === null ? mine.filter(item => (ids.has(item.item_owner) || ids.has(item.item_built_by)) && closed(item))
    : items.filter(item => item.item_id === folder && closed(item));
  return done.length ? done[done.length - 1] : null;
}

/** Commits on the tree survive its removal: on main, the closed item's recorded commit, or held by a branch Git keeps. */
function commitsKept(path, mainRoot, items, commitsSafe) {
  if (commitsSafe(path, mainRoot, items)) return true;
  try { return Boolean(String(maintenanceGit(path, ['symbolic-ref', '-q', 'HEAD'])).trim()); } catch { return false; }
}

/**
 * Remove each kept tree whose seat's item landed or was withdrawn, when it is clean, not a pool spare and holds no live claim.
 * Why: finished seats otherwise stay forever and every Git command walks them all; this runs in every maintenance cycle,
 * so a landed item's seat goes within one cycle instead of after the idle-hours wait of maintenance.retireIdleSeats.
 * A dirty tree is kept, named on its report entry and recorded once per set of dirty paths through ports.recordDirty.
 * @param {string} root checkout maintenance runs from
 * @param {object[]} entries report entries from this sweep; kept candidates are considered and removed ones are marked
 * @param {{ mainRoot: string, now: number, observed: object, ports: object, report: object, state: object, dirtyPaths: Function, commitsSafe: Function }} context
 */
export async function retireLandedSeats(root, entries, { mainRoot, now, observed, ports, report, state, dirtyPaths, commitsSafe }) {
  for (const entry of entries) {
    if (entry.action !== 'kept' || !CANDIDATE_REASONS.has(entry.reason)) continue;
    const path = resolve(entry.path);
    if (path === resolve(mainRoot) || path === resolve(root) || spare(path)) continue;
    let lease;
    try {
      const item = landedItem(path, observed, now);
      if (!item || !commitsKept(path, mainRoot, observed.items, commitsSafe)) continue;
      const dirty = dirtyPaths(path);
      if (dirty.length) {
        entry.reason = `uncommitted changes in ${path}; worktree kept`;
        entry.dirtyPaths = dirty;
        const key = JSON.stringify(dirty), tree = state.trees[entry.path];
        if (tree?.dirtyFact !== key && typeof ports.recordDirty === 'function') {
          await ports.recordDirty({ path, agents: entry.agents, items: [item.item_id], paths: dirty });
          if (tree) tree.dirtyFact = key;
        }
        continue;
      }
      lease = await takeMaintenanceCheckout(path, ports.agentId);
      // Reread the board under the lease: a claim taken since the sweep began keeps the seat.
      if (!landedItem(path, await ports.readSnapshot(), now) || dirtyPaths(path).length) continue;
      const allocated = maintenanceAllocatedBytes(path);
      maintenanceGit(root, ['worktree', 'remove', path]);
      entry.action = 'retired-landed';
      entry.reason = `clean seat whose item #${item.item_id} ${item.item_merged_commit ? 'landed' : 'was withdrawn'}`;
      report.pruned++;
      if (allocated === null) report.freedBytes = null; else if (report.freedBytes !== null) report.freedBytes += allocated;
    } catch (error) { entry.reason = error.message; } finally { lease?.release(); }
  }
}
