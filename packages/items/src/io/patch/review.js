/** Compose native companion inputs without granting their author another lane's authority [V4,H16]. */
import { composeItemPatches } from "./compose.js";
import { itemPatchPaths } from "./compose.js";
import { itemPatches } from "../patches.js";
import { itemPatchDigest } from "../patches.js";
import { itemPatchReviewProblem } from "../patches.js";
import { outOfLane } from "../../../../seats/index.js";
import { contains } from "../../../../git/index.js";
import { git } from "../../../../git/index.js";
import { differFromHead } from "../../../../git/index.js";
import { Refused } from "../../../../kernel/index.js";

/** Enforce the native source author's lane for every actual patch path. */
function authorPaths(board, config, author, paths, policyCommit) {
  const lane = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(author)?.agent_lane;
  if (!lane) throw new Refused('ITEM_PATCH_AUTHOR', 'restore the registered source author before reviewing its patch');
  const denied = outOfLane(config, lane, paths);
  const policy = policyCommit ? ` under frozen policy ${policyCommit}` : '';
  if (denied.length) throw new Refused('OUTSIDE_LANE', `patch author ${author} cannot change ${denied.join(', ')}${policy}; obtain a patch from the owning lane, or ask the coordinator to refreeze if ownership changed`);
}

/** Validate declared paths before adoption; actual paths are checked again after isolated composition. */
export function validateItemPatchInput(board, config, author, patch, policyCommit) {
  authorPaths(board, config, author, [...itemPatchPaths(patch)], policyCommit);
}

/** Bind the admitted main, submitted source and exact native patch set into the checked commit. */
export function prepareItemPatchReview(root, board, item, ports, { mergeMain = true } = {}) {
  const { effectiveItemHead, itemPolicy, requireTrunkMerge, retryReviewCommit } = ports;
  const digest = itemPatchDigest(board, item.item_id);
  const problem = itemPatchReviewProblem(board, item, digest, ports);
  if (problem) throw problem;
  const effective = effectiveItemHead(board, item);
  if (effective) {
    if (!mergeMain) return { commit: effective, paths: [], applied: [], digest, companionDigest: digest };
    const trunk = requireTrunkMerge(root, effective);
    const commit = contains(root, trunk.commit, effective) ? effective : retryReviewCommit(root, effective, trunk);
    return { commit, paths: [], applied: [], digest, companionDigest: digest };
  }
  const trunk = mergeMain ? requireTrunkMerge(root, item.item_commit) : null;
  const baseCommit = !trunk || contains(root, trunk.commit, item.item_commit) ? item.item_commit
    : retryReviewCommit(root, item.item_commit, trunk);
  const patches = itemPatches(board, item.item_id);
  const composed = composeItemPatches(root, item, patches, { ...(trunk ? { trunk: trunk.commit } : {}), baseCommit });
  const policy = itemPolicy(root, item);
  for (const applied of composed.applied) {
    const record = patches.find(patch => patch.key === applied.key);
    authorPaths(board, policy.config, record.author.agentId, applied.paths, policy.commit);
  }
  if (digest && composed.digest !== digest) throw new Refused('ITEM_PATCH_CHANGED', 'read the current patch set and restart review');
  return { ...composed, companionDigest: digest };
}

/** Describe the exact ordered companions a reservation must place in the review checkout. */
export function reviewCompanionOffer(root, board, item, ports) {
  const patches = itemPatches(board, item.item_id);
  if (!patches.length) return null;
  const composed = prepareItemPatchReview(root, board, item, ports, { mergeMain: false });
  return { commit: composed.commit, digest: composed.companionDigest, keys: patches.map(patch => patch.key) };
}

/** Compare final companion paths, including modes and deletions, rather than trusting commit ancestry. */
export function missingCompanionKeys(root, board, item, head, ports) {
  const offer = reviewCompanionOffer(root, board, item, ports);
  if (!offer) return { keys: [], digest: null };
  const keys = itemPatches(board, item.item_id).filter(patch => [...itemPatchPaths(patch.patch)].some(path => {
    const args = ['ls-tree', '-z'];
    const expected = git(root, [...args, offer.commit, '--', ':(literal)' + path]);
    const actual = git(root, [...args, head, '--', ':(literal)' + path]);
    return actual !== expected || differFromHead(root, [path]).length > 0;
  })).map(patch => patch.key);
  return { keys, digest: offer.digest };
}
