/** Where a source first reached trunk: shared by the coordinator's merge step and the runner compose job [C7,#5585]. */
import { git } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';

/** Find the earliest first-parent commit containing a source using the monotone ancestry predicate. */
export function firstContainingCommit(root, source) {
  const commits = git(root, ['rev-list', '--first-parent', 'HEAD']).split('\n').filter(Boolean);
  if (!commits.length) return undefined;
  /** Test one point in the first-parent chain; ancestry is false before the first containing point and true after it. */
  const contains = (commit) => {
    const result = tryGit(root, ['merge-base', '--is-ancestor', source, commit]);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Refused('LAND_GIT', `could not locate the first landing containing ${source}: ${result.stderr || result.stdout}`);
  };
  if (!contains(commits[0])) return undefined;
  let containing = 0;
  let absent = commits.length;
  // A source this landing just merged is first contained by the tip itself: one probe of the tip's first parent settles
  // it, where the bisection over a long trunk asked Git about ten times per merged item [C7].
  if (commits.length > 1) {
    if (contains(commits[1])) containing = 1;
    else absent = 1;
  }
  while (absent - containing > 1) {
    const middle = Math.floor((containing + absent) / 2);
    if (contains(commits[middle])) containing = middle;
    else absent = middle;
  }
  return commits[containing];
}
