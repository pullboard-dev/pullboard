/**
 * Derived results saved as files named by their key: written whole through a temporary file and a rename, so a
 * reader sees the old result or the new one, never half of one, and read back only while the key still matches [C7].
 *
 * Why here: a result that only one process understands dies with it; a result keyed by what made it can be thrown
 * away at any time and rebuilt, so a missing or stale file only costs the time to build it again.
 */
import { fileSystemAdapter } from '../../../fs/index.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const fs = fileSystemAdapter();

const SUFFIX = '.result';
const PARTIAL = /\.(\d+)\.partial$/u;

/** Whether a process id is gone: signal 0 finds no such process (a process we may not signal still lives). */
function writerIsDead(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

/**
 * Remove each temporary file in a folder whose writer process is dead: a killed writer never reached its rename or its
 * cleanup, and its half file would otherwise stay for good [C7].
 *
 * @param {string} folder
 * @returns {number} how many were removed
 */
export function removeDeadPartials(folder) {
  let removed = 0;
  let names;
  try { names = fs.list(folder); } catch { return 0; }
  for (const name of names) {
    const match = PARTIAL.exec(name);
    if (!match || Number(match[1]) === process.pid || !writerIsDead(Number(match[1]))) continue;
    try { fs.rm(join(folder, name), { force: true }); removed += 1; } catch { /* Gone already. */ }
  }
  return removed;
}

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
  fs.mkdir(folder, { recursive: true });
  removeDeadPartials(folder);
  const path = keyedResultPath(folder, key);
  const temporary = `${path}.${process.pid}.partial`;
  try {
    fs.writeFile(temporary, bytes);
    fs.rename(temporary, path);
  } finally {
    fs.rm(temporary, { force: true });
  }
}

/**
 * Capture the identity of an existing private result directory, so a later publish can tell it from a replacement.
 * A missing directory, a link or a non-directory has no identity to capture [C7].
 *
 * @param {string} folder
 * @returns {{ folder: string, dev: number, ino: number } | null}
 */
export function captureKeyedFolder(folder) {
  try {
    const stat = fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { folder, dev: stat.dev, ino: stat.ino };
  } catch { return null; }
}

/** Whether the captured directory still stands at its path: the same device and inode, still a real directory. */
function stillCaptured(captured) {
  const now = captureKeyedFolder(captured.folder);
  return now !== null && now.dev === captured.dev && now.ino === captured.ino;
}

/**
 * Save one key's result only in the directory captured earlier, never creating it: a removed directory stays absent
 * and a replacement directory is left alone. Returns { ok: true } once the result is published, or
 * { ok: false, unavailable: true, reason } when safe publication cannot be established [C7]. The bytes are staged
 * beside the directory, so a replacement is never written to before the identity check. Known limit: Node has no
 * directory-relative rename, so a swap in the instant between the final check and the rename cannot be excluded; it is
 * reported as unavailable by the check after the rename, not prevented.
 *
 * @param {{ folder: string, dev: number, ino: number } | null} captured
 * @param {string} key
 * @param {Uint8Array} bytes
 * @returns {{ ok: true } | { ok: false, unavailable: true, reason: string }}
 */
export function publishKeyedResult(captured, key, bytes) {
  const unavailable = (reason) => ({ ok: false, unavailable: true, reason });
  if (!captured || typeof captured.folder !== 'string') return unavailable('no captured directory');
  if (!stillCaptured(captured)) return unavailable('directory removed or replaced');
  const path = keyedResultPath(captured.folder, key);
  // Staged beside the directory, never inside it: a replacement that appears while the bytes are written is not touched.
  const temporary = `${captured.folder}.${process.pid}.stage`;
  try {
    fs.writeFile(temporary, bytes);
    if (!stillCaptured(captured)) return unavailable('directory replaced before publication');
    fs.rename(temporary, path);
  } catch (error) {
    return unavailable(`write failed: ${error.code ?? 'error'}`);
  } finally {
    fs.rm(temporary, { force: true });
  }
  return stillCaptured(captured) ? { ok: true } : unavailable('directory replaced during publication');
}

/**
 * The saved bytes of one key's result, or null when there is none.
 *
 * @param {string} folder
 * @param {string} key
 * @returns {Buffer | null}
 */
export function loadKeyedResult(folder, key) {
  try { return fs.readFile(keyedResultPath(folder, key)); } catch (error) {
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
  try { names = fs.list(folder).filter((name) => name.endsWith(SUFFIX)); } catch { return []; }
  const results = [];
  for (const name of names) {
    try { results.push(fs.readFile(join(folder, name))); } catch { /* Swept between the listing and the read. */ }
  }
  return results;
}

/**
 * Keep only the newest saved results in a folder, by modification time; a result swept meanwhile is already gone.
 *
 * @param {string} folder
 * @param {number} keep - How many results stay.
 */
export function pruneKeyedResults(folder, keep) {
  let names;
  try { names = fs.list(folder).filter((name) => name.endsWith(SUFFIX)); } catch { return; }
  const dated = [];
  for (const name of names) {
    try { dated.push({ name, at: fs.stat(join(folder, name)).mtimeMs }); } catch { /* Swept between the listing and the stat. */ }
  }
  for (const old of dated.sort((a, b) => b.at - a.at).slice(keep)) fs.rm(join(folder, old.name), { force: true });
}
