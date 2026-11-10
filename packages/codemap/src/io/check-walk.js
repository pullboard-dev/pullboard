/** The file walk the Rigor checks share: repo-relative sorted paths, narrowable to the files an item changed [D1,C7]. */
import { lstatSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';

const SKIPPED = new Set(['node_modules', 'work']);

/**
 * Every file under the root whose repo-relative path matches `pattern`, sorted.
 *
 * @param {string} root
 * @param {RegExp} pattern
 * @returns {string[]}
 */
export function walk(root, pattern) {
  const only = restrictedFiles();
  if (only) return only.filter(name => pattern.test(name) && isWalkable(root, name)).sort(byText);
  const found = [];
  const pending = [resolve(root)];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.')) pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = relative(root, path).split(sep).join('/');
      if (pattern.test(name)) found.push(name);
    }
  }
  return found.sort(byText);
}

let narrowed = null;

/**
 * Run a synchronous check with every walk() limited to the given repo-relative files. Why: a count
 * can only rise in files the item changed, so a doctrine hold scans just those in its own process.
 *
 * @template T
 * @param {string[]} files
 * @param {() => T} run
 * @returns {T}
 */
export function narrowedTo(files, run) {
  const before = narrowed;
  narrowed = files;
  try { return run(); } finally { narrowed = before; }
}

/** The files the current narrowing allows, or null for the whole tree. */
function restrictedFiles() {
  return narrowed;
}

/** True when a narrowed path is a regular file the full walk would also have visited. */
function isWalkable(root, name) {
  if (name.split('/').some(part => SKIPPED.has(part) || part.startsWith('.'))) return false;
  try { return lstatSync(join(root, name)).isFile(); } catch { return false; } // a deleted file has nothing to scan
}

/** Compare by UTF-16 code units, so the order never depends on the machine's locale. */
function byText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Read one walked file as text.
 *
 * @param {string} root
 * @param {string} path - repo-relative
 * @returns {string}
 */
export function readText(root, path) {
  return readFileSync(join(root, path), 'utf8');
}


/** A test file, as the affected-test selection names one: `*.test.js` or `*.spec.js`, also .mjs and .cjs. */
export const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/u;
