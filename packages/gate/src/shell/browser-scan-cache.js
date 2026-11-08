/**
 * A persisted browser-scan cache: each test file's verdict with the import closure it was computed from and the git
 * tree it was computed at. A verdict is reused when none of its closure changed between that tree and the current one,
 * which one `git diff --name-only` per cached tree decides. Why: the scan is a static walk at about 1.6 s a file, so a
 * full-suite plan spent 30 minutes on it before dispatching anything, and every batch repeated the walk [C7].
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../git/index.js';
import { git } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';

const VERSION = 1;
/** Bump when the rule deciding a verdict changes: entries of another version are recomputed, never reused. */
export const BROWSER_RULE_VERSION = 2;
const ENTRY_LIMIT = 6000;
const SHA = /^[0-9a-f]{40,64}$/u;

/** The cache file beside the board, shared by every worktree of the repository; null outside a repository. */
export function browserScanCacheFile(root) {
  try { return join(repoInfo(root).commonDir, 'pullboard', 'browser-scan.json'); } catch { return null; }
}

/** The tree the working checkout's HEAD points at, or null when it cannot be read. */
export function currentTree(root) {
  try { const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim(); return SHA.test(tree) ? tree : null; } catch { return null; }
}

/** Read a cache written by this version with owner-only permissions; anything else reads as empty. */
export function readBrowserScanCache(file) {
  const empty = { version: VERSION, entries: {} };
  if (!file) return empty;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024 * 1024) return empty;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.version !== VERSION || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return empty;
    const entries = {};
    for (const [path, entry] of Object.entries(value.entries)) {
      if (typeof path !== 'string' || !path || typeof entry?.bound !== 'boolean' || typeof entry.byLaunch !== 'boolean'
        || !SHA.test(entry.tree ?? '') || !Array.isArray(entry.closure) || entry.closure.some(item => typeof item !== 'string' || !item)) continue;
      entries[path] = { bound: entry.bound, byLaunch: entry.byLaunch, tree: entry.tree, closure: [...new Set(entry.closure)],
        ruleVersion: Number.isInteger(entry.ruleVersion) ? entry.ruleVersion : 0, reason: typeof entry.reason === 'string' ? entry.reason : '' };
    }
    return { version: VERSION, entries };
  } catch { return empty; }
}

/** Write the cache atomically, owner-only, dropping the oldest entries past the limit. */
export function writeBrowserScanCache(file, cache) {
  if (!file) return;
  const entries = Object.entries(cache.entries);
  const kept = entries.length > ENTRY_LIMIT ? Object.fromEntries(entries.slice(entries.length - ENTRY_LIMIT)) : cache.entries;
  mkdirSync(dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify({ version: VERSION, entries: kept }), { mode: 0o600 });
  renameSync(pending, file);
}

/**
 * The paths that differ between two trees, read once per pair; null when git cannot say, which callers treat as
 * everything changed.
 */
export function changedPaths(root, fromTree, toTree, memo = new Map()) {
  if (fromTree === toTree) return new Set();
  const key = `${fromTree}..${toTree}`;
  if (memo.has(key)) return memo.get(key);
  let value = null;
  try {
    const out = git(root, ['diff', '--name-only', '--no-renames', '-z', fromTree, toTree], { env: cleanGitEnvironment() });
    value = new Set(String(out).split('\0').filter(Boolean));
  } catch { value = null; }
  memo.set(key, value);
  return value;
}

/** True when a cached verdict still holds at `tree`: same mode, and no path of its closure changed since its tree. */
export function cachedVerdictHolds(entry, { byLaunch, tree, changed, ruleVersion = BROWSER_RULE_VERSION }) {
  if (!entry || entry.byLaunch !== byLaunch || !tree || entry.ruleVersion !== ruleVersion) return false;
  if (entry.tree === tree) return true;
  const diff = changed(entry.tree);
  if (diff === null) return false;
  return !entry.closure.some(path => diff.has(path));
}

/** A stable digest of a closure, for logs and tests; the cache itself keeps the paths. */
export function closureDigest(paths) {
  return createHash('sha256').update([...new Set(paths)].sort().join('\n')).digest('hex').slice(0, 16);
}

/** Whether a file exists as given; used by tests for the cache file. */
export function cacheExists(file) { return Boolean(file) && existsSync(file); }
