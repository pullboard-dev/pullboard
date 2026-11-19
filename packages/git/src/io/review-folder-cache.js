import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingLockfileRefusal } from "./committed.js";

/**
 * The cache key for one review folder's installed dependencies: the sha256 of its package-lock.json bytes [C7,#1112].
 *
 * Why the lockfile bytes: two folders with the same lockfile install the same dependencies, so they can share one cache,
 * and one changed byte means a different install.
 *
 * @param {string} folder - A review folder (see reviewFolder) holding package-lock.json.
 * @returns {string} The 64-character hex sha256 of the lockfile.
 * @throws {Refused} NO_FILE when the folder has no package-lock.json.
 */
export function lockfileCacheKey(folder) {
  const lockfile = join(folder, 'package-lock.json');
  if (!existsSync(lockfile)) throw missingLockfileRefusal(folder);
  return createHash('sha256').update(readFileSync(lockfile)).digest('hex');
}
