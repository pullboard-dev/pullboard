/** The cells path map's recorded moves, as origins for the doctrine's per-file count [D1,C7]. */
import { cleanGitEnvironment } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';

/** Run Git read-only in the checkout, without replacement objects; null when it refuses. */
function gitRead(root, args) {
  const result = tryGit(root, ['--no-replace-objects', ...args], { env: cleanGitEnvironment() });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Add the moves the cells path map records at the candidate (packages/codemap/data/plan/path-map/*.json, old path to new) to the
 * renamed origins: a changed path that a map entry names as its new path, whose old path main still had.
 * Why: a cell move renames hundreds of files at once, past Git's rename detection limit, so a moved file read as new
 * and its old problems as new problems (#1588's src/view.css).
 *
 * @param {Map<string, string>} origins - Git's detected renames, new path to origin; kept where both name a path.
 * @returns {Map<string, string>}
 */
export function withPathMapMoves(origins, root, base, commit, changed) {
  const listing = gitRead(root, ['ls-tree', '-z', '--name-only', commit, '--', 'packages/codemap/data/plan/path-map/']);
  if (!listing) return origins;
  const wanted = new Set(changed), moved = new Map(origins);
  for (const file of listing.split('\0').filter(name => /^packages\/codemap\/data\/plan\/path-map\/[^/]+\.json$/u.test(name))) {
    let map;
    try { map = JSON.parse(gitRead(root, ['show', `${commit}:${file}`]) ?? '{}'); } catch { continue; }
    for (const [from, to] of Object.entries(map ?? {})) {
      if (typeof from !== 'string' || typeof to !== 'string' || from === to || !wanted.has(to) || moved.has(to)) continue;
      if (gitRead(root, ['cat-file', '-e', `${base}:${from}`]) !== null) moved.set(to, from);
    }
  }
  return moved;
}
