/** One review of a parent covers the parent head plus each submitted slice, composed as commit objects, never on a branch [C7,#2397]. */
import { contains } from '../../../../../packages/git/index.js';
import { gitSpawnSync } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Pullboard', GIT_AUTHOR_EMAIL: 'pullboard@localhost', GIT_COMMITTER_NAME: 'Pullboard', GIT_COMMITTER_EMAIL: 'pullboard@localhost' };

/** Run one Git plumbing command, returning its result without throwing. */
function run(root, args) {
  return gitSpawnSync(args, { cwd: root, env: { ...process.env, ...IDENTITY }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** The parent's slice children that have a submitted commit, in slice id order. */
export function submittedSlices(board, parentId) {
  return board.db.prepare("SELECT item_id, item_commit FROM item WHERE item_parent_id = ? AND item_commit IS NOT NULL AND item_status IN ('submitted', 'verified') AND EXISTS (SELECT 1 FROM board_meta WHERE meta_key = 'item-slice:' || item_id) ORDER BY item_id")
    .all(parentId).map(row => ({ id: row.item_id, commit: row.item_commit }));
}

/**
 * Compose the parent head with each submitted slice's item_commit, merged in slice id order. The result is a commit object
 * only: no branch or ref is written, and a slice that conflicts refuses SLICE_COMPOSE naming its id.
 */
export function composeSliceReview(root, board, parent) {
  let commit = parent.item_commit;
  const merged = [];
  for (const slice of submittedSlices(board, parent.item_id)) {
    if (contains(root, slice.commit, commit)) continue;
    const tree = run(root, ['merge-tree', '--write-tree', '--no-messages', commit, slice.commit]);
    if (tree.status !== 0) throw new Refused('SLICE_COMPOSE', `slice #${slice.id} conflicts with the composition of #${parent.item_id} and the slices before it; merge main into that slice and resubmit it`);
    const made = run(root, ['commit-tree', String(tree.stdout).trim().split('\n')[0], '-p', commit, '-p', slice.commit, '-m', `Compose slice #${slice.id} into the review of #${parent.item_id}`]);
    if (made.status !== 0) throw new Refused('SLICE_COMPOSE', `slice #${slice.id} could not be composed into the review of #${parent.item_id}`);
    commit = String(made.stdout).trim();
    merged.push(slice.id);
  }
  return { commit, slices: merged };
}
