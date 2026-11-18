/**
 * Verify composes against main when its gate slot is granted, not when the review queues (#929). The
 * board setting is pullboard.json's verify.composeAtAdmission, off by default, so nothing changes until a
 * board turns it on. With it on, the trunk merge, the captured review and the stacked-work check run once
 * the resource queue admits the check, so a landing during the wait never voids a check that has not
 * started; a landing during the check gets one clean-composition retry in verifyHere.
 */
import {
  contains,
  isClean,
  untracked,
} from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import {
  captureVerdictReview,
  staleVerdictRefusal,
} from './freshness.js';

/**
 * Whether the board composes a review at gate admission rather than when it queues (#929).
 *
 * @param {any} config - the committed policy for the item
 * @returns {boolean}
 */
export function composesAtAdmission(config) {
  return config?.verify?.composeAtAdmission === true;
}

/**
 * Take the trunk, refuse a dirty or stale re-review, capture the review and check the stacked work, all
 * against the trunk as it is now. Called at queue time when the setting is off, and at gate admission when
 * it is on, so the composition judged is the main at that moment and is recorded with the verdict.
 *
 * @param {string} root
 * @param {any} board
 * @param {any} item
 * @param {string} checkedCommit - the commit the check runs at
 * @param {{ reReview: boolean, head: string, stale: any, refuseUnverifiedStack: (root: string, board: any, item: any, commit: string, trunk: any) => void, composeAsObject?: boolean, composeMain?: (root: string, main: string, options: { item: number|string }) => { commit: string } }} options
 *   With `composeAsObject` on, a stale re-review whose checkout lacks current main is composed as an object by `composeMain` instead of refused; `commit` is the commit to check.
 * @returns {{ trunk: any, review: any, commit: string }}
 */
export function composeReview(root, board, item, checkedCommit, { reReview, head, stale, refuseUnverifiedStack, requireTrunkMerge, events, composeAsObject = false, composeMain }) {
  const trunk = requireTrunkMerge(root, checkedCommit);
  if (reReview) {
    if (!isClean(root)) throw new Refused('DIRTY', 'commit the reviewed composition before re-reviewing the stale verdict');
    if (untracked(root).length) throw new Refused('UNTRACKED', 'commit or ignore untracked files before re-reviewing the stale verdict');
    if (!contains(root, trunk.commit, head)) {
      if (!composeAsObject || !composeMain) throw staleVerdictRefusal(item, stale);
      // The review stays bound to the composition: a fresh object of current main and this head (refs/pullboard/compose/<item>/<main12>) is what is checked and sealed [C7,U159].
      checkedCommit = composeMain(root, trunk.commit, { item: item.item_id }).commit;
    }
  }
  const review = captureVerdictReview(root, board, item, trunk.commit, checkedCommit, { events });
  refuseUnverifiedStack(root, board, item, checkedCommit, trunk);
  return { trunk, review, commit: checkedCommit };
}
