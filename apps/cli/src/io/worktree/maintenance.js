/** Archive-first maintenance acts only on freshly observed native custody [B3,C7]. */
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';
import { repoInfo } from '../../../../../packages/git/index.js';
import { maintenanceProtectedPath } from './maintenance/protection.js';
import { retainedMaintenanceHealth } from './maintenance/retention.js';
import { maintenanceDurations } from '../../../../../packages/config/index.js';
import { retireIdleSeatHours } from '../../../../../packages/config/index.js';
import { retireIdleSeats } from './maintenance/idle-seats.js';
import { retireLandedSeats } from './maintenance/landed-seat.js';
import { sweepFinishedFolders } from './maintenance/folder-sweep.js';
import { classifyMaintenanceTree } from './maintenance/classify.js';
import { goneMaintenanceSeat } from './maintenance/classify.js';
import { archiveMaintenanceWorktree } from './maintenance/archive.js';
import { removePartialArchives } from './maintenance/archive.js';
import { maintenanceArchiveMatches } from './maintenance/archive.js';
import { maintenanceGit } from './maintenance/archive.js';
import { maintenanceSnapshot } from './maintenance/archive.js';
import { maintenanceAllocatedBytes } from './maintenance/observation.js';
import { maintenanceWorkingDirectories } from './maintenance/observation.js';
import { readMaintenanceState } from './maintenance/observation.js';
import { registeredMaintenanceTrees } from './maintenance/observation.js';
import { takeMaintenanceCheckout } from './maintenance/observation.js';
import { writeMaintenanceState } from './maintenance/observation.js';
import { withMaintenanceLock } from './maintenance/observation.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Excluding a directory protects its descendants and a parent whose removal would erase it. */
function contains(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

/** A lifecycle cleanup may not discard another unfinished claim, review or submitted implementation. */
function otherObligations(snapshot, agent, item, now) {
  return snapshot.items.some(row => row.item_id !== item && (row.item_status === 'claimed' && row.item_owner === agent
    || ['submitted', 'verified'].includes(row.item_status) && !row.item_merged_commit && row.item_built_by === agent
    || row.item_review_by === agent && Date.parse(row.item_review_until ?? '') > now));
}

/** Health can observe a gone seat before its removal grace expires, while live and excluded trees remain untouched. */
function observeDirt(tree, observed, mainRoot, root, config, now) {
  if (maintenanceProtectedPath(tree.path) || tree.bare || tree.locked || contains(tree.path, mainRoot) || contains(tree.path, root)) return false;
  if (config.worktreeMaintenance.exclude.some(path => contains(path, tree.path) || contains(tree.path, path))) return false;
  const seats = observed.seats.filter(seat => resolve(seat.agent_path) === resolve(tree.path));
  if (seats.some(seat => seat.presence !== 'gone')) return false;
  return !seats.some(seat => otherObligations(observed, seat.agent_id, null, now));
}

/** Persist recovery paths separately from mutable source; native facts must complete before source is erased. */
async function recordArchive(archive, row, ports) {
  if (typeof ports.recordArchive !== 'function') throw new Error('maintenance needs its native archive-fact writer');
  await ports.recordArchive({ path: row.path, agents: row.agents, items: row.items,
    archive: archive.directory, head: archive.manifest.head, ref: archive.manifest.ref,
    signature: archive.manifest.signature, at: archive.manifest.at });
}

/** Reobserve exact registration and common-directory identity under the native checkout lease. */
function currentTree(root, common, path, head) {
  const row = registeredMaintenanceTrees(root).find(tree => resolve(tree.path) === resolve(path));
  if (!row || row.locked || row.bare || row.head !== head) throw new Error('maintenance registration changed; source retained');
  const info = repoInfo(path);
  if (fs.realpath(info.commonDir) !== common || fs.realpath(info.root) !== resolve(path))
    throw new Error('maintenance worktree identity changed; source retained');
  return row;
}

/**
 * List the paths Git reports as modified, staged or untracked in one worktree, sorted and unique.
 * Why: a worktree holding any of these is somebody's unfinished work, so maintenance must never remove or reset it.
 * @param {string} path absolute worktree folder
 * @returns {string[]} dirty paths; empty when the worktree is clean
 */
export function maintenanceDirtyPaths(path) {
  const fields = String(maintenanceGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
  const found = new Set();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4) continue;
    found.add(field.slice(3));
    // A rename or copy entry is followed by its source path as a separate field; record it too.
    if (/[RC]/u.test(field.slice(0, 2))) {
      index++;
      if (fields[index]) found.add(fields[index]);
    }
  }
  return [...found].sort();
}

/**
 * Keep a dirty worktree in place: say why on the report entry and record a fact naming the folder and its dirty paths.
 * The fact is written once per distinct set of dirty paths, so an hourly sweep does not repeat itself.
 * @param {object} ports maintenance ports; an optional recordDirty writes the native fact
 * @param {{ path: string, agents: string[], items: (string|number)[] }} row the classified tree
 * @param {string[]} paths the dirty paths
 * @param {object} entry the report entry to explain
 * @param {boolean} fresh whether this set of dirty paths is new since the last sweep
 */
async function keepDirty(ports, row, paths, entry, fresh = true) {
  entry.reason = `uncommitted changes in ${row.path}; worktree kept`;
  entry.dirtyPaths = paths;
  if (!fresh || typeof ports.recordDirty !== 'function') return;
  try { await ports.recordDirty({ path: row.path, agents: row.agents, items: row.items, paths }); }
  catch (error) { entry.reason += `; its fact could not be recorded: ${error.message}`; }
}

/**
 * Say whether every commit on a worktree is safe to drop: reachable from the main checkout's head, or the recorded commit of a landed or withdrawn item.
 * Why: an idle joined seat is retired without a takeover, so its commits are the only record of work that never reached main (#8199).
 * @param {string} path absolute worktree folder
 * @param {string} mainRoot the main checkout
 * @param {object[]} items board item rows
 * @returns {boolean} true when nothing on the tree is unmerged
 */
export function maintenanceCommitsSafe(path, mainRoot, items) {
  const head = String(maintenanceGit(path, ['rev-parse', 'HEAD'])).trim();
  const unmerged = String(maintenanceGit(path, ['rev-list', head, '--not', String(maintenanceGit(mainRoot, ['rev-parse', 'HEAD'])).trim()])).trim();
  if (!unmerged) return true;
  return items.some(item => item.item_commit === head && (Boolean(item.item_merged_commit) || item.item_status === 'withdrawn' || Boolean(item.item_withdrawn_reason)));
}

/** One summary has no file contents, individual shell commands, or inferred cleanup claims. */
export function maintenanceSummary(report) {
  const freed = report.freedBytes === null ? 'unknown' : String(report.freedBytes) + ' B';
  return `maintenance: active ${report.counts.active}, finished ${report.counts.finished}, orphaned ${report.counts.orphaned}, scratch ${report.counts.scratch}; pruned ${report.pruned}; archived ${report.archived}; space freed ${freed}${report.enabled ? '' : '; off'}`;
}

/** Free only claims whose holder and checkout still match the gone-seat observation under the checkout lease. */
async function releaseGoneMaintenanceClaims(root, config, observed, trees, ports, now, readDirectories, directories) {
  const refusals = new Map();
  if (!ports.releaseGoneClaim) return refusals;
  const seats = new Map(observed.seats.map(seat => [seat.agent_id, seat]));
  const registered = new Map(trees.map(tree => [resolve(tree.path), tree]));
  for (const claim of observed.items) {
    if (claim.item_status !== 'claimed' || claim.item_owner === 'coordinator') continue;
    const seat = seats.get(claim.item_owner);
    if (!seat?.agent_path) continue;
    const path = resolve(seat.agent_path);
    const lastSeen = goneMaintenanceSeat(seat, observed.takeoverMs, now, directories);
    if (lastSeen === null || maintenanceProtectedPath(path) || contains(path, root)) continue;
    if (config.worktreeMaintenance.exclude.some(excluded => contains(resolve(root, excluded), path) || contains(path, resolve(root, excluded)))) continue;
    if (observed.seats.some(other => other !== seat && other.agent_path && resolve(other.agent_path) === path
      && goneMaintenanceSeat(other, observed.takeoverMs, now, directories) === null)) continue;
    const tree = registered.get(path) ?? registered.get(`${path}-item-${claim.item_id}`);
    if (!tree || tree.locked || tree.bare) continue;
    let lease;
    try {
      lease = await takeMaintenanceCheckout(tree.path, ports.agentId);
      await ports.releaseGoneClaim(claim, seat, lastSeen, readDirectories);
    } catch (error) {
      refusals.set(path, error.message);
      refusals.set(`${path}-item-${claim.item_id}`, error.message);
    } finally { lease?.release(); }
  }
  return refusals;
}

/** Classify every registered tree, retaining uncertain work and revalidating each deletion after its archive/facts. */
export async function runWorktreeMaintenance(root, config, ports, { now = Date.now() } = {}) {
  if (typeof ports?.readSnapshot !== 'function') throw new Error('maintenance needs its native custody reader');
  const report = { version: 1, id: randomUUID(), at: new Date(now).toISOString(), enabled: config.worktreeMaintenance?.enabled === true,
    counts: { active: 0, finished: 0, orphaned: 0, scratch: 0 }, pruned: 0, archived: 0, freedBytes: 0, entries: [] };
  if (!report.enabled) return report;
  const info = repoInfo(root), common = fs.realpath(info.commonDir);
  return withMaintenanceLock(common, async () => {
  removePartialArchives(common);
  const trees = registeredMaintenanceTrees(root);
  const mainRoot = trees[0].path, prior = readMaintenanceState(common), next = { version: 1, trees: {}, lastRun: report };
  const durations = maintenanceDurations(config.worktreeMaintenance);
  const readDirectories = ports.workingDirectories ?? maintenanceWorkingDirectories;
  const beforeRelease = await ports.readSnapshot();
  const directories = readDirectories();
  const refusals = await releaseGoneMaintenanceClaims(root, config, beforeRelease, trees, ports, now, readDirectories, directories);
  const observed = ports.releaseGoneClaim ? await ports.readSnapshot() : beforeRelease;
  for (const tree of trees) {
    const previous = Object.hasOwn(prior.trees, tree.path) ? prior.trees[tree.path] : undefined;
    const row = classifyMaintenanceTree(tree, { mainRoot, currentRoot: root, config,
      ...observed, previous, now, workingDirectories: directories });
    report.counts[row.kind]++;
    const entry = { ...row, action: 'kept' };
    report.entries.push(entry);
    next.trees[tree.path] = { firstSeenAt: previous?.firstSeenAt ?? now,
      inactiveSince: row.inactiveSince, agents: row.agents, dirtySince: previous?.dirtySince ?? null,
      dirtyFact: previous?.dirtyFact ?? null,
      ...(previous?.retainedWithdrawal ? { retainedWithdrawal: previous.retainedWithdrawal } : {}) };
    if (refusals.has(resolve(tree.path))) {
      entry.reason = refusals.get(resolve(tree.path));
      continue;
    }
    if (observeDirt(tree, observed, mainRoot, root, config, now)) {
      try {
        currentTree(root, common, tree.path, tree.head);
        const dirty = Boolean(maintenanceGit(tree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
        next.trees[tree.path].dirtySince = dirty ? previous?.dirtySince ?? now : null;
      } catch (error) { entry.reason = error.message; continue; }
    }
    if (row.protected || !row.oldEnough) continue;
    let lease;
    try {
      lease = await takeMaintenanceCheckout(tree.path, ports.agentId);
      const actual = currentTree(root, common, tree.path, tree.head);
      const fresh = classifyMaintenanceTree(actual, { mainRoot, currentRoot: root, config,
        ...await ports.readSnapshot(), previous: next.trees[tree.path], now, workingDirectories: readDirectories() });
      if (fresh.protected || !fresh.oldEnough) { entry.reason = fresh.reason; continue; }
      if (fresh.retiredIdle && !maintenanceCommitsSafe(tree.path, mainRoot, (await ports.readSnapshot()).items)) {
        entry.reason = `unmerged commits in ${row.path}; worktree kept`;
        continue;
      }
      const dirtyPaths = maintenanceDirtyPaths(tree.path);
      next.trees[tree.path].dirtySince = dirtyPaths.length ? previous?.dirtySince ?? now : null;
      if (dirtyPaths.length) {
        const key = JSON.stringify(dirtyPaths);
        await keepDirty(ports, fresh, dirtyPaths, entry, previous?.dirtyFact !== key);
        next.trees[tree.path].dirtyFact = key;
        continue;
      }
      next.trees[tree.path].dirtyFact = null;
      const allocated = maintenanceAllocatedBytes(tree.path);
      const archive = archiveMaintenanceWorktree(tree.path, common, { now: report.at, includeMetadata: true, ...(ports.archiveVolume ? { volume: ports.archiveVolume } : {}) });
      await recordArchive(archive, fresh, ports);
      report.archived++;
      entry.archive = archive.directory;
      entry.action = 'archived';
      writeMaintenanceState(common, next);
      const last = currentTree(root, common, tree.path, tree.head);
      const final = classifyMaintenanceTree(last, { mainRoot, currentRoot: root, config,
        ...await ports.readSnapshot(), previous: next.trees[tree.path], now, workingDirectories: readDirectories() });
      if (final.protected || !final.oldEnough || !maintenanceArchiveMatches(tree.path, archive))
        throw new Error('maintenance custody or bytes changed after archive; source retained');
      const archiveSize = maintenanceAllocatedBytes(archive.directory);
      const late = maintenanceDirtyPaths(tree.path);
      if (late.length) { await keepDirty(ports, fresh, late, entry); entry.action = 'archived-kept'; continue; }
      maintenanceGit(root, ['worktree', 'remove', tree.path]);
      if (fs.exists(tree.path)) throw new Error('maintenance removal did not complete');
      entry.action = 'pruned';
      report.pruned++;
      if (allocated === null || archiveSize === null) report.freedBytes = null;
      else if (report.freedBytes !== null) report.freedBytes += Math.max(0, allocated - archiveSize);
      delete next.trees[tree.path];
    } catch (error) {
      entry.reason = error.message;
      entry.action = entry.archive ? 'archived-kept' : 'kept';
    } finally { lease?.release(); }
  }
  // A seat whose item landed or was withdrawn goes in this same cycle once it is clean, idle and claim-free (#10783).
  await retireLandedSeats(root, report.entries, { mainRoot, now, observed, ports, report, state: next,
    dirtyPaths: maintenanceDirtyPaths, commitsSafe: maintenanceCommitsSafe });
  // Folders of landed, withdrawn and dead-seat items go each cycle, inside the grace; dirty ones keep their diff at a keep ref (#12537).
  await sweepFinishedFolders(root, report.entries, { mainRoot, now, config, observed: await ports.readSnapshot(), ports, report, dirtyPaths: maintenanceDirtyPaths, readDirectories });
  // With maintenance.retireIdleSeats on, clean trees idle past the set hours whose HEAD is already on main go too (#9109).
  const idleHours = retireIdleSeatHours();
  if (idleHours !== null) await retireIdleSeats(root, report.entries, { mainRoot, hours: idleHours, now, observed, ports, report, dirtyPaths: maintenanceDirtyPaths });
  for (const entry of report.entries) if (['retired-idle', 'retired-landed', 'swept'].includes(entry.action)) delete next.trees[entry.path];
  // A dirty worktree remains a health finding only after repeated observations spanning a day.
  next.lastRun.finishedAt = new Date().toISOString();
  next.lastRun.nextAt = new Date(now + durations.everyMs).toISOString();
  writeMaintenanceState(common, next);
  return report;
  });
}

/** Clean only an explicitly released/withdrawn/retired seat, never its other unfinished obligations. */
export async function cleanMaintenanceSeat(root, config, ports, { path, item, agent, retired = false, withdrawn = false, now = Date.now() }) {
  if (config.worktreeMaintenance?.enabled !== true) return null;
  if (maintenanceProtectedPath(path)) return null;
  if (resolve(path) !== resolve(root) && !(retired && ports.completedTakeover === true)
    && !(withdrawn && ports.completedWithdrawal === true)) return null;
  const info = repoInfo(root), common = fs.realpath(info.commonDir), trees = registeredMaintenanceTrees(root);
  const tree = trees.find(row => resolve(row.path) === resolve(path));
  if (!tree || tree.locked || tree.bare || tree.path === trees[0].path) return null;
  const snapshot = await ports.readSnapshot();
  const withdrawalConfirmed = state => !withdrawn || ports.completedWithdrawal === true
    && state.items.some(row => row.item_id === item && row.item_status === 'withdrawn' && !row.item_owner);
  if (!withdrawalConfirmed(snapshot)) return null;
  if (otherObligations(snapshot, agent, item, now)) return null;
  const settings = config.worktreeMaintenance;
  if (settings.exclude.some(excluded => contains(excluded, path) || contains(path, excluded))) return null;
  let lease;
  try {
    lease = await takeMaintenanceCheckout(path, ports.agentId);
    currentTree(root, common, path, tree.head);
    const census = () => {
      if (resolve(path) === resolve(root)) return true;
      const rows = (ports.workingDirectories ?? maintenanceWorkingDirectories)();
      return Array.isArray(rows) && rows.every(row => {
        const cwd = typeof row === 'string' ? row : row?.path ?? row?.cwd;
        return typeof cwd === 'string' && !contains(path, cwd);
      });
    };
    if (!census()) return null;
    const fresh = await ports.readSnapshot();
    if (!fresh.seats.some(seat => seat.agent_id === agent && resolve(seat.agent_path) === resolve(path))) return null;
    if (!withdrawalConfirmed(fresh)) return null;
    if (otherObligations(fresh, agent, item, now)) return null;
    if (fresh.items.some(row => row.item_status === 'claimed' && row.item_owner === agent)) return null;
    if (retired && fresh.seats.some(seat => seat.agent_id === agent && seat.presence === 'live') && !ports.completedTakeover)
      return null;
    const row = { path, agents: [agent], items: [item].filter(id => id !== undefined && id !== null) };
    // An explicit withdrawal or completed takeover archives the work before cleaning; ordinary release keeps dirty trees.
    const explicit = withdrawn || retired;
    const dirty = explicit ? [] : maintenanceDirtyPaths(path);
    if (dirty.length) { await keepDirty(ports, row, dirty, {}); return null; }
    const archive = archiveMaintenanceWorktree(path, common, { now: new Date(now).toISOString(), ...(ports.archiveVolume ? { volume: ports.archiveVolume } : {}) });
    await recordArchive(archive, row, ports);
    currentTree(root, common, path, tree.head);
    const final = await ports.readSnapshot();
    if (!withdrawalConfirmed(final)) return null;
    if (!final.seats.some(seat => seat.agent_id === agent && resolve(seat.agent_path) === resolve(path))
      || final.seats.some(seat => seat.agent_id !== agent && resolve(seat.agent_path) === resolve(path) && seat.presence !== 'gone')
      || otherObligations(final, agent, item, now)
      || final.items.some(row => row.item_status === 'claimed' && row.item_owner === agent)) return null;
    if (!census()) return null;
    if (!maintenanceArchiveMatches(path, archive)) throw new Error('released work changed after archive; source retained');
    const late = explicit ? [] : maintenanceDirtyPaths(path);
    if (late.length) { await keepDirty(ports, row, late, {}); return null; }
    maintenanceGit(path, ['reset', '--hard', archive.manifest.head]);
    maintenanceGit(path, ['clean', '-fdx']);
    return { path, item, archive: archive.directory, clean: !maintenanceSnapshot(path).dirty };
  } finally { lease?.release(); }
}

/** Read retained dirty observations only; health never starts a scan, resets a tree or borrows imported liveness. */
export function maintenanceHealth(common, snapshot, now = Date.now()) {
  const state = readMaintenanceState(common);
  return [...retainedMaintenanceHealth(state), ...Object.entries(state.trees).flatMap(([path, entry]) => {
    if (!Number.isFinite(entry.dirtySince) || now - entry.dirtySince < 86_400_000) return [];
    const seats = snapshot.seats.filter(seat => resolve(seat.agent_path) === resolve(path));
    if (seats.some(seat => seat.presence !== 'gone') || seats.some(seat => snapshot.items.some(item =>
      item.item_status === 'claimed' && item.item_owner === seat.agent_id))) return [];
    if (entry.retainedWithdrawal) return [];
    return [{ path, since: new Date(entry.dirtySince).toISOString(), reason: 'uncommitted work without a live seat for over a day' }];
  })];
}
