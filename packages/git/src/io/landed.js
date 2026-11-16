/** The git-backed landed fact: which commits are on main, read once per main commit [C7]. */
import { git } from './main.js';
import { mainCheckout } from './main.js';

/** The set of commits reachable from main, by main commit; one rev-list per main commit, kept for the process. */
const reachable = new Map();

/**
 * A reader answering whether a commit is on main, for roadmap, show, the view and withdraw to share (isLanded's onMain).
 * Why a set: one rev-list of main per main commit, not one git process per item. Null when main cannot be read, so the
 * caller reads the recorded merge as before.
 *
 * @param {string} root - the repository root.
 * @returns {((commit: string) => boolean) | null}
 */
export function mainLandedReader(root) {
  const tip = mainCheckout(root)?.commit;
  if (!tip) return null;
  if (!reachable.has(tip)) {
    let listed;
    try { listed = git(root, ['rev-list', tip], { maxBuffer: 256 * 1024 * 1024 }); } catch { return null; }
    reachable.clear();
    reachable.set(tip, new Set(listed.split('\n').filter(Boolean)));
  }
  const commits = reachable.get(tip);
  return commit => commits.has(commit);
}
