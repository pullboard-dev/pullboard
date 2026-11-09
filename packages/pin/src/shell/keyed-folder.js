/**
 * Folders named by a content key: placed whole by one rename, touched on each use and swept by age [C7].
 * Why here: a folder keyed by what made it can be thrown away at any time and rebuilt, so the pin cell owns it as it
 * owns keyed results; callers build into a private staging folder and hand it over.
 */
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Move a finished staging folder to its keyed name, unless a folder already holds that name; a staging folder that
 * was not moved is removed.
 *
 * @param {string} staging - A complete private folder.
 * @param {string} target - The keyed folder name.
 * @returns {boolean} Whether this staging folder became the keyed folder.
 */
export function placeKeyedFolder(staging, target) {
  try { renameSync(staging, target); return true; }
  catch { return false; /* The keyed folder exists already; the caller decides whether it is usable. */ }
}

/**
 * Remove a staging folder a caller did not place.
 *
 * @param {string} staging
 */
export function dropStagingFolder(staging) {
  rmSync(staging, { recursive: true, force: true });
}

/**
 * Mark a keyed folder used now, so an age sweep keeps it.
 *
 * @param {string} path
 */
export function touchKeyedFolder(path) {
  const now = new Date();
  utimesSync(path, now, now);
}

/**
 * Remove the keyed folders in `parent` whose names `matches` accepts, other than `keep`, unused for `maxAgeMs`.
 * A folder that cannot be read stays.
 *
 * @param {string} parent
 * @param {{ matches: (name: string) => boolean, keep?: string|null, maxAgeMs: number, now?: number }} options
 * @returns {string[]} The names removed.
 */
export function sweepKeyedFolders(parent, { matches, keep = null, maxAgeMs, now = Date.now() }) {
  let names = [];
  try { names = readdirSync(parent); } catch { return []; }
  const removed = [];
  for (const name of names) {
    const path = join(parent, name);
    if (!matches(name) || path === keep) continue;
    try {
      if (now - statSync(path).mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch { /* Another sweep removed it. */ }
  }
  return removed;
}
