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
 * Save the bytes of one key's result through a temporary file and a rename, so a reader sees the old result or the
 * new one, never half of one.
 *
 * @param {string} folder
 * @param {string} key
 * @param {Uint8Array} bytes
 */
export function saveKeyedResult(folder, key, bytes) {
  mkdirSync(folder, { recursive: true });
  const path = keyedResultPath(folder, key);
  const temporary = `${path}.${process.pid}.partial`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
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
