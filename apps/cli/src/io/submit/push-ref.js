import { tryGit } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** The first of these refs that names a commit in the clone: the host main this clone last fetched. */
const MAIN_REFS = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main'];

/** The commit a ref names in the clone, or '' when it names none. */
function commitOf(cwd, ref) {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).stdout;
}

/**
 * The commit this clone pushed for a submit and the ref it pushed it to, as {head, ref}, for a board host that fetches
 * it from trunk.remote instead of taking a bundle. The commit must be on the pushed branch and descend from the host main
 * this clone fetched, so the host never gates work that dropped main's commits.
 * Why: a seat that pushed its work needs no bundle; refusing a stale base here saves the round trip to the host [P7].
 *
 * @param {string} cwd - The clone.
 * @param {{ item: number }} binding
 * @returns {{ head: string, ref: string }}
 */
export function pushedCommits(cwd, { item }) {
  const head = commitOf(cwd, 'HEAD');
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Refused('NO_COMMIT', 'nothing committed yet; commit the item work in this clone, then submit');
  const branch = tryGit(cwd, ['symbolic-ref', '--quiet', 'HEAD']).stdout;
  if (!branch.startsWith('refs/heads/')) throw new Refused('DETACHED_HEAD', `HEAD is detached; check out the branch for #${item}, push it to the trunk remote and submit again`);
  const ref = tryGit(cwd, ['config', '--get', `branch.${branch.slice('refs/heads/'.length)}.merge`]).stdout || branch;
  const upstream = commitOf(cwd, '@{upstream}');
  if (!upstream || tryGit(cwd, ['merge-base', '--is-ancestor', head, upstream]).status !== 0) {
    throw new Refused('COMMIT_NOT_PUSHED', `${head.slice(0, 12)} is not pushed to the trunk remote; git push -u origin HEAD, then submit again`);
  }
  const main = MAIN_REFS.map((name) => commitOf(cwd, name)).find(Boolean);
  if (!main) throw new Refused('NO_MAIN_REF', 'this clone has not fetched the host main; git fetch origin, merge origin/main, push and submit again');
  if (tryGit(cwd, ['merge-base', '--is-ancestor', main, head]).status !== 0) {
    throw new Refused('NOT_ON_MAIN', `${head.slice(0, 12)} does not descend from the host main ${main.slice(0, 12)}; merge main, push, and submit again`);
  }
  return { head, ref };
}

/**
 * The commits a URL-joined seat's submit carries, by its board.commits mode: none when off, a bundle, or the pushed head and ref.
 * Why one chooser: the mode is read by the caller, outside the move, and handed here as plain data [P7,C7].
 *
 * @param {{ commits?: string }} remote - The seat's board.url settings.
 * @param {{ verb: string, item?: number, agent: string }} body - The move about to be sent.
 * @param {string} cwd - The clone.
 * @returns {Promise<object | undefined>}
 */
export async function carriedCommits(remote, body, cwd) {
  if (body.verb !== 'submit' && body.verb !== 'done') return undefined;
  if (remote.commits === 'bundle') return (await import('./pull.js')).bundleCommits(cwd, body);
  if (remote.commits === 'pushed') return pushedCommits(cwd, body);
  return undefined;
}
