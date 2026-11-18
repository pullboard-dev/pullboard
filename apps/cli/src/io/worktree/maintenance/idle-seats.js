/** Retire clean, idle seat worktrees whose HEAD is already on main, behind maintenance.retireIdleSeats [C7,#9109]. */
import { existsSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { maintenanceGit } from './archive.js';
import { itemObligation } from './classify.js';
import { maintenanceAllocatedBytes } from './observation.js';
import { takeMaintenanceCheckout } from './observation.js';

/** Why a classified tree is still a candidate: only checkouts no live claim speaks for, never a protected one. */
const CANDIDATE_REASONS = new Set(['outside-maintenance-scratch', 'seat-joined', 'seat-idle']);

/** The newest time anything touched the tree: its folder, its Git admin folder and its index. */
function lastTouched(path) {
  const gitDir = String(maintenanceGit(path, ['rev-parse', '--absolute-git-dir'])).trim();
  const stamps = [path, gitDir, join(gitDir, 'index'), join(gitDir, 'HEAD')].filter(file => existsSync(file)).map(file => statSync(file).mtimeMs);
  return stamps.length ? Math.max(...stamps) : Infinity;
}

/** True when a live seat, or a claim, review or unmerged submission of a seat registered at this tree or its item folder, still counts. */
function heldBySeat(path, observed, now) {
  const owners = new Set(observed.seats.filter(seat => {
    const root = resolve(seat.agent_path ?? seat.path ?? '/');
    return root === path || path.startsWith(`${root}-item-`);
  }).map(seat => seat.agent_id));
  const live = observed.seats.some(seat => owners.has(seat.agent_id) && seat.presence === 'live');
  return live || observed.items.some(item => (owners.has(item.item_owner) || owners.has(item.item_built_by) || owners.has(item.item_review_by)) && itemObligation(item, now));
}

/**
 * Remove each kept tree that is clean, untouched for `hours`, not held by a live seat or claim, and whose HEAD is an ancestor of main.
 * Why: a tree on main holds nothing main lacks, so nothing needs archiving; `git worktree remove` without force still refuses a dirty or locked tree.
 * @param {string} root checkout maintenance runs from
 * @param {object[]} entries report entries from this sweep; kept ones are considered and pruned ones are marked
 * @param {{ mainRoot: string, hours: number, now: number, observed: object, ports: object, report: object, dirtyPaths: Function }} context
 */
export async function retireIdleSeats(root, entries, { mainRoot, hours, now, observed, ports, report, dirtyPaths }) {
  const mainHead = String(maintenanceGit(mainRoot, ['rev-parse', 'HEAD'])).trim();
  for (const entry of entries) {
    if (entry.action !== 'kept' || !CANDIDATE_REASONS.has(entry.reason)) continue;
    const path = resolve(entry.path);
    if (path === resolve(mainRoot) || path === resolve(root)) continue;
    let lease;
    try {
      if (heldBySeat(path, observed, now)) continue;
      if (now - lastTouched(path) <= hours * 3_600_000) continue;
      const head = String(maintenanceGit(path, ['rev-parse', 'HEAD'])).trim();
      try { maintenanceGit(mainRoot, ['merge-base', '--is-ancestor', head, mainHead]); } catch { continue; }
      if (dirtyPaths(path).length) continue;
      lease = await takeMaintenanceCheckout(path, ports.agentId);
      const allocated = maintenanceAllocatedBytes(path);
      maintenanceGit(root, ['worktree', 'remove', path]);
      if (existsSync(path)) continue;
      entry.action = 'retired-idle';
      entry.reason = `clean seat idle over ${hours} h with HEAD on main`;
      report.pruned++;
      if (allocated === null) report.freedBytes = null; else if (report.freedBytes !== null) report.freedBytes += allocated;
    } catch (error) { entry.reason = error.message; } finally { lease?.release(); }
  }
}
