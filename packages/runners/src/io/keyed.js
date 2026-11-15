/**
 * The runner cell's keyed store: folders and results named by a content key, written whole by one rename, touched on
 * use and swept by age [C7]. Why here: anything keyed by what made it can be thrown away at any time and rebuilt, and
 * the runner controller keeps its tooling exports and scan verdicts without reaching another cell. Every path is the
 * caller's; this module names no state root.
 */
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
/** The one saveKeyedResult is the pin cell's, reached through the transport cell this cell already imports, so no pin edge is added. */
export { saveKeyedResult } from '../../../transport/index.js';

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
 * Write one empty lease file, private to this user, in `folder`; its holder removes it when done.
 *
 * @param {string} folder
 * @param {string} name
 */
export function writeKeyedLease(folder, name) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, name), '', { mode: 0o600 });
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

/** The file one key's result lives in: a digest of the key, so any key names a safe file. */
function keyedResultPath(folder, key) {
  return join(folder, createHash('sha256').update(key).digest('hex').slice(0, 32) + '.result');
}

/**
 * The saved bytes of one key's result, or null when there is none.
 *
 * @param {string} folder
 * @param {string} key
 * @returns {Buffer | null}
 */
export function loadKeyedResult(folder, key) {
  try { return readFileSync(keyedResultPath(folder, key)); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** The variable a runner job names its runner's shared cache folder in; every job on one runner gets the same one. */
export const SHARED_CACHE_ENV = 'PULLBOARD_RUNNER_SHARED_CACHE';

/** The most bytes one shared cache folder keeps; its oldest files go first. */
export const SHARED_CACHE_MAX_BYTES = 256 * 1024 ** 2;

const bounded = new Set();

/**
 * One named folder of this runner's shared cache, made private to this user, or null outside a runner job or when the
 * folder is not this user's alone. Why: each runner job gets its own TMPDIR and HOME, so caches kept there started
 * empty in every job and a cold first trip cost 43-54 s (#8189); a folder holds only results keyed by what made them.
 *
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function sharedCacheFolder(name, env = process.env) {
  const root = env[SHARED_CACHE_ENV];
  if (!root || !isAbsolute(root)) return null;
  const folder = join(root, name);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const state = statSync(folder);
    if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) return null;
  } catch { return null; }
  if (!bounded.has(folder)) { bounded.add(folder); boundKeyedFolder(folder, SHARED_CACHE_MAX_BYTES); }
  return folder;
}

/**
 * Remove the oldest files under `folder` until what remains fits `maxBytes`. A reader that loses a file to this sweep
 * only misses, since every entry is rebuilt from its key.
 *
 * @param {string} folder
 * @param {number} maxBytes
 * @returns {number} The files removed.
 */
export function boundKeyedFolder(folder, maxBytes) {
  let names = [];
  try { names = readdirSync(folder, { recursive: true }); } catch { return 0; }
  const files = [];
  let total = 0;
  for (const name of names) {
    try {
      const state = statSync(join(folder, name));
      if (!state.isFile()) continue;
      files.push({ path: join(folder, name), size: state.size, at: state.mtimeMs });
      total += state.size;
    } catch { /* Removed meanwhile. */ }
  }
  let removed = 0;
  for (const file of files.sort((a, b) => a.at - b.at)) {
    if (total <= maxBytes) break;
    try { rmSync(file.path, { force: true }); total -= file.size; removed++; } catch { /* Another sweep took it. */ }
  }
  return removed;
}
