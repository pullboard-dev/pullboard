/**
 * Count direct imports of node:fs in source files outside the kernel folder, and refuse new ones [C7,#9449].
 * A source file reaches the file system through the file-system adapter in packages/kernel, so a test can hand it a fake one. The
 * offenders that exist today are held by a per-file ceiling that never rises; a file past its ceiling is a finding naming file, line and adapter.
 *
 * Why: scattered node:fs imports tie every module to the real disk, so the lint stops the count from growing while the
 * adapter replaces them. Behind gate.adapterLintFs, off by default: with it off the lint reports nothing.
 */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { join } from 'node:path';
import { walk } from '../scan.js';

/** The file system this file reads through, so a test can hand a fake one [C7]. */
const disk = fileSystemAdapter();

/** The ceilings file: per-file counts of today's direct node:fs imports, repo-relative. */
export const FS_CEILING_FILE = 'packages/gate/data/ceilings/adapter-lint-fs.json';

const KERNEL = 'packages/kernel/';
/**
 * The files whose node:fs imports live inside generated child-process scripts (the two submit files, the runner probe, and the capsule installer stringified into the remote install script, #11632), which cannot import the adapter.
 *
 * Why: the lint counts import text, so these files can never reach zero by migration; exempting them by exact path keeps
 * the imports visible here instead of rewriting the generated scripts to dodge the count [C7].
 */
const GENERATED_CHILD_SCRIPTS = new Set(['apps/cli/src/io/submit/pull.js', 'apps/cli/src/io/submit/remote.js', 'packages/runners/src/io/probe.js', 'packages/runners/src/io/package/install.js']);
const SOURCE_FILE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|bin)\/.*\.[cm]?js$/u;
const FS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])(?:node:)?fs(?:\/promises)?\1/gu;

/** Whether a repo-relative path is a source file the lint covers: not the kernel, not a test, not a generated-child-script file. */
export const coveredByFsLint = path => SOURCE_FILE.test(path) && !path.startsWith(KERNEL) && !GENERATED_CHILD_SCRIPTS.has(path)
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
  try { ceilings = JSON.parse(disk.readFile(join(root, FS_CEILING_FILE), 'utf8')).files ?? {}; } catch { ceilings = {}; }
  const files = {};
  for (const path of walk(root, SOURCE_FILE)) if (coveredByFsLint(path)) files[path] = disk.readFile(join(root, path), 'utf8');
  return fsFindings(files, ceilings);
}
