/** claim.refuseOffMainHead: claim refuses a folder whose HEAD is not on main, so no claim records a base trunk never held [C7,#9104]. */
import { Refused } from '../../../kernel/index.js';
import { refuseOffMainHead } from '../../../config/index.js';
import { tryGit } from '../../../git/index.js';

/**
 * The CLAIM_HEAD_OFF_MAIN refusal for a folder whose HEAD is neither main's tip nor an ancestor of it, or null.
 * Off (the default) it returns null, so claim takes the folder as it stands. A folder git cannot answer for is left to
 * claim's other checks. Why: #9000's builder committed before claiming, then rewrote that commit, so no ref on trunk held
 * the claim base and its first gate went red NO_POLICY, as the runner could not fetch it.
 *
 * @param {string} root - The folder claim runs in.
 * @param {{ trunk?: string, enabled?: boolean }} [options] - trunk: main's branch name; enabled: claim.refuseOffMainHead.
 * @returns {Refused | null}
 */
export function offMainHeadRefusal(root, { trunk = 'main', enabled = refuseOffMainHead() } = {}) {
  if (!enabled) return null;
  const head = tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.status !== 0) return null;
  const onMain = tryGit(root, ['merge-base', '--is-ancestor', 'HEAD', trunk]);
  if (onMain.status !== 1) return null;
  const sha = head.stdout.trim().slice(0, 12);
  return new Refused('CLAIM_HEAD_OFF_MAIN', `this folder's HEAD ${sha} is not on ${trunk}, so the runner could not fetch the claim base`,
    `keep your commits on a branch (git branch keep-${sha} HEAD), put the folder on ${trunk} (git checkout --detach ${trunk}), then claim again and cherry-pick them into the item folder`);
}
