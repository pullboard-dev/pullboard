/** Temp folders as caches named by tree id: rebuilt from the bundle when missing, swept without breaking a job [C7]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Refused } from '../../../kernel/light.js';
import { bundleFor } from './main.js';
import { isObjectId } from '../logic/names.js';

const fs = fileSystemAdapter();

/**
 * Name the cache folder for a tree.
 *
 * @param {string} cacheRoot - Where caches live.
 * @param {string} tree - A full tree id.
 * @returns {string} The folder path, named by tree id alone.
 */
export function cachePath(cacheRoot, tree) {
  if (!isObjectId(tree)) throw new Refused('PIN_TREE_INVALID', 'A cache is named by a full tree id; resolve the commit with pinFor first.');
  return join(cacheRoot, tree);
}

/**
 * Return the cache folder for a tree, rebuilding it from the bundle when it is missing.
 *
 * Why: a sweep may delete any cache at any time, so every reader asks here instead of holding a path. The
 * rebuild unpacks beside the final name and renames, so a reader never sees a half-built folder. Touching the
 * folder on each use keeps recently used caches out of an age sweep.
 *
 * @param {string} repo - The repository holding the tree, used only if the bundle is missing too.
 * @param {string} tree - A full tree id.
 * @param {{ cacheRoot: string, bundles: string }} where - The cache and bundle folders.
 * @returns {{ path: string, rebuilt: boolean }} The folder and whether it had to be rebuilt.
 */
export function cacheFor(repo, tree, { cacheRoot, bundles }) {
  const path = cachePath(cacheRoot, tree);
  if (fs.exists(path)) {
    const now = new Date();
    try { fs.utimes(path, now, now); } catch { /* a sweep removed it between the check and the touch; rebuild below */ }
    if (fs.exists(path)) return { path, rebuilt: false };
  }
  const bundle = bundleFor(repo, tree, bundles);
  fs.mkdir(cacheRoot, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  fs.rm(partial, { recursive: true, force: true });
  fs.mkdir(partial);
  try {
    const result = spawnSync('tar', ['-xf', bundle.path, '-C', partial], { encoding: 'utf8' });
    if (result.status !== 0) throw new Refused('PIN_CACHE_FAILED', `Unpacking ${bundle.path} failed: ${String(result.stderr ?? result.error?.message ?? '').trim()}. Delete the bundle so it is rebuilt, then retry.`);
    try { fs.rename(partial, path); }
    catch (error) { if (!fs.exists(path)) throw error; }
  } finally {
    fs.rm(partial, { recursive: true, force: true });
  }
  return { path, rebuilt: true };
}

/**
 * Remove caches nobody needs: not named in `keep` and not used within `maxAgeMs`.
 *
 * Why: queued jobs name their trees, so their caches are kept; and any cache removed anyway is rebuilt by
 * cacheFor from the bundle, so a sweep can lose time but never a job.
 *
 * @param {string} cacheRoot - Where caches live.
 * @param {{ keep?: Iterable<string>, maxAgeMs?: number, now?: number }} [options] - Tree ids to keep and the age limit.
 * @returns {string[]} The tree ids removed.
 */
export function sweepCaches(cacheRoot, { keep = [], maxAgeMs = 0, now = Date.now() } = {}) {
  if (!fs.exists(cacheRoot)) return [];
  const kept = new Set(keep);
  const removed = [];
  for (const name of fs.list(cacheRoot)) {
    if (!isObjectId(name) || kept.has(name)) continue;
    const path = join(cacheRoot, name);
    if (maxAgeMs > 0 && now - fs.stat(path).mtimeMs < maxAgeMs) continue;
    fs.rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
