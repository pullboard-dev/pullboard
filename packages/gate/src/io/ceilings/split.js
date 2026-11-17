/** Whether a new file's ceiling row is covered by the file it was split from, judged on the cells each imports [L3,C7]. */
import { fileEdges } from '../edges.js';

/** The set of `cell` or `cell/src` targets a source imports across cells. */
function targetsOf(file, source) {
  return new Set(fileEdges(file, source).map(edge => `${edge.to}${edge.deep ? '/src' : ''}`));
}

/** The text of a blob entry from the commits cell's reader, or null when the path is absent in that revision. */
function textAt(read, revision, path) {
  const entry = read(revision, path);
  return entry?.bytes ? entry.bytes.toString('utf8') : null;
}

/**
 * A new file split out of an old one carries the cross-cell imports it needs, which the old file may still hold, so its
 * cells-edges row is not new ceiling. It is covered when some file listed on main still exists, now imports no cell it
 * did not import on main, and imported on main every cell (and deep target) the new file imports. A new file reaching
 * one more cell is not covered. Why: a split that moves code leaves the old file's imports alone, so the pair's row
 * total rose and every such split was refused though no cell-to-cell edge was added.
 *
 * @param {{ file: string, old: Record<string, object>, next: Record<string, object>, read: (revision: string, path: string) => ({ bytes?: Buffer } | null) }} context
 *   `old` and `next` are the table's rows on HEAD and in the index; `read` returns a blob entry at `HEAD` or `:index`.
 * @returns {boolean}
 */
export function splitRowCovered({ file, old, next, read }) {
  if (typeof read !== 'function' || !/\.[cm]?js$/u.test(file)) return false;
  const added = textAt(read, ':index', file);
  if (added === null) return false;
  const wanted = targetsOf(file, added);
  for (const origin of Object.keys(old)) {
    if (origin === file || !next[origin]) continue;
    const before = textAt(read, 'HEAD', origin), now = textAt(read, ':index', origin);
    if (before === null || now === null) continue;
    const had = targetsOf(origin, before);
    if (![...wanted].every(target => had.has(target))) continue;
    if ([...targetsOf(origin, now)].every(target => had.has(target))) return true;
  }
  return false;
}
