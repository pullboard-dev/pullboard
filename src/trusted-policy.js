/** Coordinator policy and immutable submission declarations, independent of check execution [V4,V16,L3,M3]. */
import { localDependencyIds } from './item-dependencies.js';
import { trunkMerge } from './trunk-merge.js';
export { trunkMerge } from './trunk-merge.js';
import {
  mainPolicy,
  policyAt,
  policyGit,
  trunkRef,
} from './trusted-policy-read.js';
export { mainPolicy, policyAt, trunkRef } from './trusted-policy-read.js';
import { refuseGrafts } from './git.js';
import { outOfLane } from './lanes.js';
import { Refused } from './refused.js';

/** Resolve the trunk snapshot and refuse a conflict without touching an index or worktree [B34,V6].
 *
 * Returning the exact ref and tip lets later candidate checks use the same snapshot this merge
 * check validated.
 *
 * @param {string} root
 * @param {string} commit
 * @param {string} [retainedRef]
 * @returns {{ ref: string, commit: string }}
 */
export function requireTrunkMerge(root, commit, retainedRef = trunkRef(root)) {
  const { files, ...trunk } = trunkMerge(root, commit, retainedRef);
  if (!files) return trunk;
  const branch = trunk.ref.replace(/^refs\/heads\//, '');
  throw new Refused('MERGE_CONFLICT', `the candidate conflicts with the current trunk ${branch} in ${files.map(path => JSON.stringify(path)).join(', ') || 'unresolved files'}; merge the trunk into your branch, resolve these files, commit and resubmit`);
}

/** Use new claims' frozen policy; legacy claims retain their committed claim-base settings. */
export function itemPolicy(root, item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen ?? 'null'); }
  catch { throw new Refused('NO_POLICY', 'the frozen criterion is invalid; ask the coordinator to refreeze this item'); }
  return policyAt(root, frozen?.policy?.commit ?? item.item_claim_head);
}

/** Compare a path's mode and object, including deletions, against an authenticated main snapshot. */
function pathObject(root, commit, path) {
  return policyGit(root, ['ls-tree', '-z', commit, '--', ':(literal)' + path]);
}

/** Enforce item changes from every shared ancestry base; newer unrelated main changes are not item reversions. */
export function submissionPaths(root, item, commit, { config, mainCommit, dependencies = [] } = {}) {
  refuseGrafts(root);
  const policy = itemPolicy(root, item);
  const base = item.item_claim_head;
  if (!/^[0-9a-f]{40,64}$/.test(base ?? '')) throw new Refused('NO_POLICY', 'this item has no claim base; ask the coordinator to refreeze it and claim again');
  policyGit(root, ['rev-parse', '--verify', base + '^{commit}']);
  const snapshot = mainCommit ?? policy.commit;
  policyAt(root, snapshot); // Authenticate main before using it in ancestry or object comparisons.
  // Include main to catch a foreign reversion after merging it; every crisscross base is conservative.
  const bases = [...new Set([base, policy.commit, snapshot].flatMap(start =>
    policyGit(root, ['merge-base', '--all', start, commit]).trim().split('\n').filter(Boolean)))];
  const changed = bases.flatMap(start => policyGit(root, ['diff', '--no-renames', '--name-only', '-z', start, commit, '--']).split('\0').filter(Boolean));
  const paths = [...new Set(changed)];
  const ownership = config ?? policy.config;
  const foreign = paths.filter(path => outOfLane(ownership, item.item_lane, [path]).length);
  const accepted = dependencies.map(dependency => ({ ...dependency,
    paths: new Set(policyGit(root, ['diff', '--no-renames', '--name-only', '-z', dependency.base, dependency.commit, '--']).split('\0').filter(Boolean)),
  }));
  // A path still equal to main at every merge base arrived only through a merge of main, so it is not the item change.
  const mainBases = policyGit(root, ['merge-base', '--all', snapshot, commit]).trim().split('\n').filter(Boolean);
  const denied = foreign.filter(path => {
    const object = pathObject(root, commit, path);
    if (object === pathObject(root, snapshot, path)) return false;
    if (mainBases.length && mainBases.every(start => object === pathObject(root, start, path))) return false;
    return !accepted.some(dependency => dependency.paths.has(path)
      && !outOfLane(ownership, dependency.lane, [path]).length
      && object === pathObject(root, dependency.commit, path));
  });
  if (denied.length) throw new Refused('OUTSIDE_LANE', 'outside the ' + item.item_lane + ' lane: ' + outOfLane(ownership, item.item_lane, denied).join(', ') + ` under frozen policy ${policy.commit}; shout the owner and restore these paths before submitting, or ask the coordinator to refreeze if ownership changed`);
  return paths;
}

/** Verified dependencies may contribute their own unchanged lane files, including through a verified chain [N16]. */
export function dependencySnapshots(db, item) {
  const pending = localDependencyIds(item);
  const visited = new Set();
  const snapshots = [];
  while (pending.length) {
    const id = pending.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const row = db.prepare("SELECT item_lane, item_claim_head, item_commit, item_after FROM item WHERE item_id=? AND item_status='verified' AND EXISTS (SELECT 1 FROM verdict WHERE item_id=? AND verdict_decision='ACCEPT' AND verdict_commit=item.item_commit)").get(id, id);
    if (!row?.item_claim_head || !/^[0-9a-f]{40,64}$/.test(row.item_commit ?? '')) continue;
    snapshots.push({ lane: row.item_lane, base: row.item_claim_head, commit: row.item_commit });
    pending.push(...localDependencyIds(row));
  }
  return snapshots;
}

/** Read the command frozen with the criterion, preventing a later edit from changing its proof. */
export function frozenCheck(item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen ?? 'null'); } catch { return ''; }
  return frozen?.check ?? (item.item_frozen ? '' : item.item_check ?? '');
}

