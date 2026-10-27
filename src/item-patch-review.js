/** Compose native companion inputs without granting their author another lane's authority [V4,H16]. */
import { composeItemPatches, itemPatchPaths } from './item-patch-compose.js';
import { itemPatches, itemPatchDigest, itemPatchReviewProblem } from './item-patches.js';
import { outOfLane } from './lanes.js';
import { contains } from './git.js';
import { itemPolicy, requireTrunkMerge } from './trusted-policy.js';
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
export function prepareItemPatchReview(root, board, item) {
  const digest = itemPatchDigest(board, item.item_id);
  const problem = itemPatchReviewProblem(board, item, digest);
  if (problem) throw problem;
  const trunk = requireTrunkMerge(root, item.item_commit);
  const baseCommit = contains(root, trunk.commit, item.item_commit) ? item.item_commit
    : retryReviewCommit(root, item.item_commit, trunk);
  const patches = itemPatches(board, item.item_id);
  const composed = composeItemPatches(root, item, patches, { trunk: trunk.commit, baseCommit });
  const config = itemPolicy(root, item).config;
  for (const applied of composed.applied) {
    const record = patches.find(patch => patch.key === applied.key);
    authorPaths(board, config, record.author.agentId, applied.paths);
  }
  if (digest && composed.digest !== digest) throw new Refused('ITEM_PATCH_CHANGED', 'read the current patch set and restart review');
  return { ...composed, companionDigest: digest };
}
