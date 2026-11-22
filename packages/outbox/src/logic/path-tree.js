/**
 * A queued move's review paths as a nested path tree, for people and agents reading one move (GitHub #35) [C7].
 * Why: a verify move binds every literal path of the item's diff, and a flat array repeats each shared prefix; the
 * tree names each folder once. It is a view only: the stored relay move keeps its sorted `review.paths` array.
 */

/** The key that marks a folder that is itself one of the paths; a stored path never has an empty segment. */
export const SELF = '';

/**
 * The nested tree of literal paths: one key per segment, null for a path's last segment, and a "" key inside a folder
 * that is also a path. No globs: every path is written out.
 *
 * @param {string[]} paths
 * @returns {Record<string, any>}
 */
export function pathTree(paths) {
  const root = {};
  for (const path of [...new Set(paths)].sort()) {
    let node = root;
    const parts = path.split('/');
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      if (last) {
        if (node[part] && typeof node[part] === 'object') node[part][SELF] = null;
        else node[part] = null;
        return;
      }
      if (node[part] === null) node[part] = { [SELF]: null };
      else if (!node[part]) node[part] = {};
      node = node[part];
    });
  }
  return root;
}

/**
 * The sorted literal paths a tree names, the inverse of pathTree.
 *
 * @param {Record<string, any>} tree
 * @returns {string[]}
 */
export function treePaths(tree) {
  const paths = [];
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === SELF) { if (prefix) paths.push(prefix); continue; }
      const path = prefix ? `${prefix}/${key}` : key;
      if (value === null) paths.push(path);
      else walk(value, path);
    }
  };
  walk(tree, '');
  return paths.sort();
}

/** A copy of one object whose review holds `pathTree` in place of `paths`, or the object itself when it has none. */
function treeReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.review?.paths)) return value;
  const { paths, ...review } = value.review;
  return { ...value, review: { ...review, pathTree: pathTree(paths) } };
}

/**
 * A copy of a queued move whose review, on the move or on any of its arguments (a verify move carries it in its
 * options argument), holds `pathTree` in place of `paths`. The move it reads is left as it was.
 *
 * @param {Record<string, any>} move
 * @returns {Record<string, any>}
 */
export function treeView(move) {
  const copy = treeReview(structuredClone(move));
  return Array.isArray(copy?.args) ? { ...copy, args: copy.args.map(treeReview) } : copy;
}
