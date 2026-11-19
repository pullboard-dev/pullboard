/**
 * Count direct imports of node:fs in source files outside the kernel folder, and refuse new ones [C7,#9449].
 * A source file reaches the file system through the file-system adapter in packages/kernel, so a test can hand it a fake one. The
 * offenders that exist today are held by a per-file ceiling that never rises; a file past its ceiling is a finding naming file, line and adapter.
 *
 * Why: scattered node:fs imports tie every module to the real disk, so the lint stops the count from growing while the
 * adapter replaces them. Behind gate.adapterLintFs, off by default: with it off the lint reports nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../scan.js';

/** The ceilings file: per-file counts of today's direct node:fs imports, repo-relative. */
export const FS_CEILING_FILE = 'packages/gate/data/ceilings/adapter-lint-fs.json';

const KERNEL = 'packages/kernel/';
/** The runner probe, exempt by exact path: its node:fs import sits inside a script text that runs on the runner, which cannot import an adapter [C7,#11632]. */
const GENERATED_SCRIPT = 'packages/runners/src/io/probe.js';
const SOURCE_FILE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|bin)\/.*\.[cm]?js$/u;
const FS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])(?:node:)?fs(?:\/promises)?\1/gu;

/** Whether a repo-relative path is a source file the lint covers: not the kernel, not a test. */
export const coveredByFsLint = path => SOURCE_FILE.test(path) && !path.startsWith(KERNEL) && path !== GENERATED_SCRIPT
  && !/(?:^|\/)tests?\//u.test(path) && !/[-_.]test\.[cm]?js$/u.test(path);

/**
 * Every direct node:fs import in one file's text, one row per import, skipping lines that are only comments.
 *
 * @param {string} source - File text.
 * @returns {{line: number, read: string}[]} Rows in line order.
 */
export function fsReads(source) {
  const rows = [];
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const match of text.matchAll(FS_IMPORT)) rows.push({ line: index + 1, read: match[0] });
  });
  return rows;
}

/**
 * The findings of the lint over a set of files: each file whose count passes its ceiling reports every read, with the adapter to use.
 *
 * @param {Record<string, string>} files - Repo-relative path to text.
 * @param {Record<string, number>} [ceilings] - Per-file counts that may not rise; a file not listed holds zero.
 * @returns {string[]} `path:line: ...` rows, sorted.
 */
export function fsFindings(files, ceilings = {}) {
  const rows = [];
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByFsLint(path)) continue;
    const reads = fsReads(source);
    if (reads.length <= (ceilings[path] ?? 0)) continue;
    for (const read of reads) rows.push(`${path}:${read.line}: ${read.read} read directly outside the kernel (${reads.length} in this file, ceiling ${ceilings[path] ?? 0}); use the file-system adapter in packages/kernel`);
  }
  return rows.sort();
}

/** The per-file counts for a set of files, for writing the ceilings file. */
export function fsCounts(files) {
  const counts = {};
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByFsLint(path)) continue;
    const count = fsReads(source).length;
    if (count) counts[path] = count;
  }
  return counts;
}

/**
 * Run the lint over a checkout. Off (the default) it reports nothing and reads nothing.
 *
 * @param {string} root - Checkout root.
 * @param {{enabled?: boolean}} [options] - `enabled` is gate.adapterLintFs.
 * @returns {string[]} Findings, empty when the setting is off or no file passes its ceiling.
 */
export function fsLintRows(root, { enabled = false } = {}) {
  if (enabled !== true) return [];
  let ceilings = {};
  try { ceilings = JSON.parse(readFileSync(join(root, FS_CEILING_FILE), 'utf8')).files ?? {}; } catch { ceilings = {}; }
  const files = {};
  for (const path of walk(root, SOURCE_FILE)) if (coveredByFsLint(path)) files[path] = readFileSync(join(root, path), 'utf8');
  return fsFindings(files, ceilings);
}
