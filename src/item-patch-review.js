import { effectiveItemHead } from './source-advance-state.js';
/** Compose native companion inputs without granting their author another lane's authority [V4,H16]. */
import { composeItemPatches } from './item-patch-compose.js';
import { itemPatchPaths } from './item-patch-compose.js';
import { itemPatches } from './item-patches.js';
import { itemPatchDigest } from './item-patches.js';
import { itemPatchReviewProblem } from './item-patches.js';
import { outOfLane } from './lanes.js';
import { contains } from './git.js';
import { itemPolicy } from './trusted-policy.js';
import { requireTrunkMerge } from './trusted-policy.js';
import { retryReviewCommit } from './verdict-retry.js';
import { Refused } from './refused.js';

/** Enforce the native source author's lane for every actual patch path. */
function authorPaths(board, config, author, paths) {
  const lane = board.db.prepare('SELECT agent_lane FROM agent WHERE agent_id=?').get(author)?.agent_lane;
  if (!lane) throw new Refused('ITEM_PATCH_AUTHOR', 'restore the registered source author before reviewing its patch');
  const denied = outOfLane(config, lane, paths);
  if (denied.length) throw new Refused('OUTSIDE_LANE', `patch author ${author} cannot change ${denied.join(', ')}; obtain a patch from the owning lane`);
}

/** Validate declared paths before adoption; actual paths are checked again after isolated composition. */
export function validateItemPatchInput(board, config, author, patch) {
  authorPaths(board, config, author, [...itemPatchPaths(patch)]);
}

/** Bind the admitted main, submitted source and exact native patch set into the checked commit. */
export function prepareItemPatchReview(root, board, item, { mergeMain = true } = {}) {
  const digest = itemPatchDigest(board, item.item_id);
  const problem = itemPatchReviewProblem(board, item, digest);
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
  const config = itemPolicy(root, item).config;
  for (const applied of composed.applied) {
    const record = patches.find(patch => patch.key === applied.key);
    authorPaths(board, config, record.author.agentId, applied.paths);
  }
  if (digest && composed.digest !== digest) throw new Refused('ITEM_PATCH_CHANGED', 'read the current patch set and restart review');
  return { ...composed, companionDigest: digest };
}
