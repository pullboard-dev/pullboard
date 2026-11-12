/** One private base checkout per commit for a doctrine hold, shared by every main-side rule [C7]. */
import {
  gitChildEnv,
  gitSpawnSync,
} from '../../../git/index.js';

/**
 * Open a hold's base checkouts: `run` checks out a commit in a private shared clone the first time it is asked and
 * runs each later rule at that commit in the same checkout, cloning afresh only when an earlier rule left it dirty;
 * `close` removes them all. Why: every submit rule cloned and checked out main again, four clones per new main on
 * each runner (#3900).
 *
 * @param {(cwd: string, command: string, timeoutMs: number) => Promise<{ problems: string[], broken: string, seconds: number }>} runRule
 * @param {(commit: string) => { checkout: string|null, close: () => void }} open Makes one private checkout of a commit
 *   (checkout null when Git cannot) and removes it on close.
 * @returns {{ run: (commit: string, command: string, timeoutMs: number) => Promise<object>, close: () => void, clones: () => number }}
 */
export function baseCheckouts(runRule, open) {
  const checkouts = new Map(), opened = [];
  let clones = 0;
  /** A fresh private checkout of the commit, or null when Git cannot make it. */
  function checkOut(commit) {
    const made = open(commit);
    opened.push(made);
    clones += 1;
    return made.checkout;
  }
  /** True when the checkout still holds exactly its commit's tree, with nothing changed or added. */
  function clean(checkout, commit) {
    const env = gitChildEnv(checkout);
    const head = gitSpawnSync(['rev-parse', 'HEAD'], { cwd: checkout, env, encoding: 'utf8' });
    const status = gitSpawnSync(['status', '--porcelain', '--untracked-files=all', '--ignored'], { cwd: checkout, env, encoding: 'utf8' });
    return head.status === 0 && head.stdout.trim() === commit && status.status === 0 && status.stdout === '';
  }
  /** Run one rule at the commit in its shared checkout. */
  async function run(commit, command, timeoutMs) {
    let checkout = checkouts.get(commit);
    if (!checkout || !clean(checkout, commit)) {
      checkout = checkOut(commit);
      if (!checkout) { checkouts.delete(commit); return { problems: [], broken: 'could not check out the base commit', seconds: 0 }; }
      checkouts.set(commit, checkout);
    }
    return runRule(checkout, command, timeoutMs);
  }
  /** Remove every checkout this hold made. */
  function close() {
    checkouts.clear();
    for (const made of opened.splice(0)) made.close();
  }
  return { run, close, clones: () => clones };
}
