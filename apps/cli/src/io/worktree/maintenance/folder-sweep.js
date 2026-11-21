/** Sweep seat and item folders whose item landed or was withdrawn, or whose seat is gone, inside the grace window [C7,#12537]. */
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { cleanGitEnvironment } from '../../../../../../packages/git/index.js';
import { fileSystemAdapter } from '../../../../../../packages/fs/index.js';
import { gitSpawnSync } from '../../../../../../packages/git/index.js';
import { maintenanceGit } from './archive.js';
import { goneMaintenanceSeat } from './classify.js';
import { claimEnded } from './classify.js';
import { classifyMaintenanceTree } from './classify.js';
import { claimEndedKeepRef } from './claim-ended.js';
import { registeredMaintenanceTrees } from './observation.js';
import { itemObligation } from './classify.js';
import { maintenanceAllocatedBytes } from './observation.js';
import { takeMaintenanceCheckout } from './observation.js';

const fs = fileSystemAdapter();
const ITEM_FOLDER = /-item-([1-9]\d*)$/u;
const ITEM_BRANCH = /^refs\/heads\/[a-z][a-z0-9-]*\/item-([1-9]\d*)$/u;
/** Classifier reasons these rules may override: grace, idle and scratch only. A claim, lock, process or exclusion never qualifies. */
const SWEEPABLE = new Set(['outside-maintenance-scratch', 'seat-joined', 'seat-idle', 'seat-recent-or-clock-rollback', 'seat-age-unknown',
  'no-live-seat-or-work-claim', 'all-linked-work-closed']);

/** An item has landed (merged commit) or was withdrawn. */
function closed(item) {
  return Boolean(item.item_merged_commit) || item.item_status === 'withdrawn' || Boolean(item.item_withdrawn_reason);
}

function inside(parent, child) {
  const part = relative(parent, child);
  return part.length > 0 && part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep);
}

function git(path, args, env = {}) {
  const result = gitSpawnSync(args, { cwd: path, env: { ...cleanGitEnvironment(), GIT_OPTIONAL_LOCKS: '0', ...env }, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0 || result.error || result.signal) throw new Error('folder sweep Git step failed: ' + args[0]);
  return String(result.stdout).trim();
}

function quiet(path, args) {
  try { return git(path, args); } catch { return null; }
}

/** Which rule lets this tree go, or null to keep it. */
function sweepRule(path, { seats, items, takeoverMs }, { now, branch, directories }) {
  const match = ITEM_FOLDER.exec(path) ?? ITEM_BRANCH.exec(branch ?? '');
  const own = match ? items.find(item => item.item_id === Number(match[1])) : null;
  // A live claim, review or unmerged submission of the folder's own item keeps it, whoever holds it.
  if (own && itemObligation(own, now)) return null;
  // The claim ended (released or lapsed): the folder goes whoever else the seat holds, as the clock's folder row says.
  if (own && claimEnded(own, now)) return { rule: 'claim-ended', item: own.item_id };
  const owners = seats.filter(seat => {
    const root = resolve(seat.agent_path ?? seat.path ?? '/');
    return root === path || (ITEM_FOLDER.test(path) && path === `${root}-item-${ITEM_FOLDER.exec(path)[1]}`);
  });
  const ids = new Set(owners.map(seat => seat.agent_id));
  const holds = items.some(item => (ids.has(item.item_owner) || ids.has(item.item_built_by) || ids.has(item.item_review_by)) && itemObligation(item, now));
  if (holds) return null;
  if (own && closed(own) && ITEM_FOLDER.test(path)) return { rule: 'item-closed', item: own.item_id };
  if (own && closed(own) && owners.length === 0) return { rule: 'item-closed', item: own.item_id };
  // A seat is gone once the classifier found it idle past the line's takeover window, the window claims use (#8199).
  // Presence alone never proves a seat left: a rejoined or hookless seat keeps an old heartbeat (#5969).
  if (owners.length) return owners.every(seat => goneMaintenanceSeat(seat, takeoverMs, now, directories) !== null) ? { rule: 'dead-seat', item: own?.item_id ?? null } : null;
  // No board row speaks for it: an item folder whose seat folder is gone.
  const seatPath = ITEM_FOLDER.test(path) ? path.replace(ITEM_FOLDER, '') : null;
  if (seatPath && !fs.exists(seatPath)) return { rule: 'dead-seat', item: own?.item_id ?? null };
  return null;
}

/** Save the folder's uncommitted work, untracked files included, as a commit at a keep ref; returns the ref. */
function keepDiff(path, name, fresh = false) {
  const gitDir = git(path, ['rev-parse', '--absolute-git-dir']);
  const index = join(gitDir, 'pullboard-keep-index');
  try {
    const env = { GIT_INDEX_FILE: index };
    git(path, ['read-tree', 'HEAD'], env);
    git(path, ['add', '-A', '--', '.'], env);
    const tree = git(path, ['write-tree'], env);
    const commit = git(path, ['-c', 'user.name=Pullboard', '-c', 'user.email=board@pullboard.invalid', 'commit-tree', tree, '-p', 'HEAD',
      '-m', `keep uncommitted work of ${basename(path)}`]);
    const ref = fresh ? claimEndedKeepRef(name, candidate => quiet(path, ['rev-parse', '-q', '--verify', candidate]) !== null) : `refs/pullboard/keep/${name}`;
    git(path, ['update-ref', ref, commit]);
    return { ref, commit };
  } finally { if (fs.exists(index)) fs.unlink(index); }
}

/**
 * Remove each kept tree under the seat root or <main>/.claude/worktrees whose item landed or was withdrawn (rule item-closed),
 * or whose seat is not live and holds no claimed or submitted item (rule dead-seat). The 1-day grace does not apply.
 * A clean tree goes with `git worktree remove` (never --force); a dirty one keeps its diff at refs/pullboard/keep/<id> and stays.
 * Each removal and each keep is logged through ports.recordSweep as a board event naming the rule.
 */
export async function sweepFinishedFolders(root, entries, { mainRoot, now, config, observed, ports, report, dirtyPaths, readDirectories }) {
  const main = resolve(mainRoot), agents = resolve(main, '.claude', 'worktrees');
  const seatRoots = new Set(observed.seats.map(seat => seat.agent_path ?? seat.path).filter(Boolean).map(path => dirname(resolve(path))));
  const directories = readDirectories();
  for (const entry of entries) {
    if (entry.action !== 'kept') continue;
    const path = resolve(entry.path);
    if (path === main || path === resolve(root) || /-spare(?:[-.\d]|$)/u.test(basename(path))) continue;
    const agentTree = inside(agents, path);
    if (!agentTree && !seatRoots.has(dirname(path))) continue;
    const dirtyKept = typeof entry.reason === 'string' && entry.reason.startsWith('uncommitted changes in ');
    if (!SWEEPABLE.has(entry.reason) && !dirtyKept && !(agentTree && entry.reason === 'recovery-checkout')) continue;
    let lease;
    try {
      const branch = quiet(path, ['symbolic-ref', '-q', 'HEAD']);
      if (!sweepRule(path, observed, { now, branch, directories })) continue;
      lease = await takeMaintenanceCheckout(path, ports.agentId);
      // Check fresh Git registration, processes and board custody under the checkout lease.
      const current = registeredMaintenanceTrees(root).find(tree => resolve(tree.path) === path);
      if (!current || current.locked || current.bare || branch !== quiet(path, ['symbolic-ref', '-q', 'HEAD'])) continue;
      const fresh = await ports.readSnapshot(), currentDirectories = readDirectories();
      const row = classifyMaintenanceTree(current, { mainRoot, currentRoot: root, config,
        ...fresh, now, workingDirectories: currentDirectories });
      if (!SWEEPABLE.has(row.reason) && !(agentTree && row.reason === 'recovery-checkout')) continue;
      const found = sweepRule(path, fresh, { now, branch, directories: currentDirectories });
      if (!found) continue;
      const dirty = dirtyPaths(path);
      if (dirty.length) {
        const name = found.item ?? basename(path);
        const removeAfter = found.rule === 'claim-ended';
        const kept = keepDiff(path, name, removeAfter);
        if (removeAfter) {
          // The fact naming the kept commit lands before the folder goes; a failed record leaves the folder.
          await ports.recordSweep?.({ action: 'kept', rule: found.rule, path, item: found.item, ref: kept.ref, commit: kept.commit });
          // Git's forced removal drops ignored files too, which the keep commit does not hold: those stay.
          if (maintenanceGit(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])) { entry.reason = 'ignored data are outside folder sweep custody; worktree kept'; continue; }
          maintenanceGit(root, ['worktree', 'remove', '--force', path]);
          if (fs.exists(path)) { entry.reason = `uncommitted changes kept at ${kept.ref}; worktree kept (rule ${found.rule})`; entry.keepRef = kept.ref; continue; }
          entry.action = 'swept';
          entry.keepRef = kept.ref;
          entry.reason = `dirty folder removed after its diff was kept at ${kept.ref} (rule ${found.rule})`;
          report.pruned++;
          await ports.recordSweep?.({ action: 'removed', rule: found.rule, path, item: found.item, ref: kept.ref });
          continue;
        }
        entry.reason = `uncommitted changes kept at ${kept.ref}; worktree kept (rule ${found.rule})`;
        entry.keepRef = kept.ref;
        await ports.recordSweep?.({ action: 'kept', rule: found.rule, path, item: found.item, ref: kept.ref, commit: kept.commit });
        continue;
      }
      // Git's non-forced removal still drops ignored files. They are outside the keep ref's custody.
      if (maintenanceGit(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])) {
        entry.reason = 'ignored data are outside folder sweep custody; worktree kept';
        continue;
      }
      // A detached head that main lacks keeps its commit at a keep ref before the folder goes.
      let ref = null;
      const head = quiet(path, ['rev-parse', 'HEAD']);
      if (!branch && head && quiet(main, ['merge-base', '--is-ancestor', head, 'HEAD']) === null) {
        ref = `refs/pullboard/keep/${found.item ?? basename(path)}`;
        git(path, ['update-ref', ref, head]);
      }
      const allocated = maintenanceAllocatedBytes(path);
      maintenanceGit(root, ['worktree', 'remove', path]);
      if (fs.exists(path)) continue;
      entry.action = 'swept';
      entry.reason = `clean folder removed by rule ${found.rule}`;
      report.pruned++;
      if (allocated === null) report.freedBytes = null; else if (report.freedBytes !== null) report.freedBytes += allocated;
      await ports.recordSweep?.({ action: 'removed', rule: found.rule, path, item: found.item, ref });
    } catch (error) { entry.reason = error.message; } finally { lease?.release(); }
  }
}
