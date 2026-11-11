/**
 * Derived results saved as files named by their key: written whole through a temporary file and a rename, so a
 * reader sees the old result or the new one, never half of one, and read back only while the key still matches [C7].
 *
 * Why here: a result that only one process understands dies with it; a result keyed by what made it can be thrown
 * away at any time and rebuilt, so a missing or stale file only costs the time to build it again.
 */
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const SUFFIX = '.result';

/**
 * The file a key's result lives in: a digest of the key, so any key names a safe file.
 *
 * @param {string} folder
 * @param {string} key
 * @returns {string}
 */
export function keyedResultPath(folder, key) {
  return join(folder, createHash('sha256').update(key).digest('hex').slice(0, 32) + SUFFIX);
}

/**
 * Save the bytes of one key's result, replacing an older one. A failed save leaves the older result in place.
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

/**
 * Every saved result's bytes in a folder, for a reader that learns the keys from the results themselves.
 *
 * @param {string} folder
 * @returns {Buffer[]}
 */
export function savedKeyedResults(folder) {
  let names;
  try { names = readdirSync(folder).filter((name) => name.endsWith(SUFFIX)); } catch { return []; }
  const results = [];
  for (const name of names) {
    try { results.push(readFileSync(join(folder, name))); } catch { /* Swept between the listing and the read. */ }
  }
  return results;
}
