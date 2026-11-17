/**
 * Count direct reads of the environment (process.env and config files) in source files outside the kernel folder, and refuse new ones [C7,#9448].
 * A source file reads the environment through the environment adapter in packages/kernel, so a test can hand it a fixed environment. The
 * offenders that exist today are held by a per-file ceiling that never rises; a file past its ceiling is a finding naming file, line and adapter.
 *
 * Why: scattered process.env and config-file reads make behaviour depend on the machine, so the lint stops the count from growing while the
 * adapter replaces them. Behind gate.adapterLintEnv, off by default: with it off the lint reports nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../scan.js';

/** The ceilings file: per-file counts of today's direct environment reads, repo-relative. */
export const ENV_CEILING_FILE = 'packages/gate/data/ceilings/adapter-lint-env.json';

const KERNEL = 'packages/kernel/';
const SOURCE_FILE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|bin)\/.*\.[cm]?js$/u;
const ENV_READ = /(?<![\w$.])process\.env\b|(?<![\w$])(['"`])(?:[^'"`\n]*\/)?(?:[\w.-]*(?:config|settings)\.json|\.env(?:\.[\w-]+)?|\.pullboardrc)\1/gu;

/** Whether a repo-relative path is a source file the lint covers: not the kernel, not a test. */
export const coveredByEnvLint = path => SOURCE_FILE.test(path) && !path.startsWith(KERNEL)
  && !/(?:^|\/)tests?\//u.test(path) && !/[-_.]test\.[cm]?js$/u.test(path);

/**
 * Every direct environment read in one file's text, one row per read, skipping lines that are only comments.
 *
 * @param {string} source - File text.
 * @returns {{line: number, read: string}[]} Rows in line order.
 */
export function envReads(source) {
  const rows = [];
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const match of text.matchAll(ENV_READ)) rows.push({ line: index + 1, read: match[0] });
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
export function envFindings(files, ceilings = {}) {
  const rows = [];
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByEnvLint(path)) continue;
    const reads = envReads(source);
    if (reads.length <= (ceilings[path] ?? 0)) continue;
    for (const read of reads) rows.push(`${path}:${read.line}: ${read.read} read directly outside the kernel (${reads.length} in this file, ceiling ${ceilings[path] ?? 0}); use the environment adapter in packages/kernel`);
  }
  return rows.sort();
}

/** The per-file counts for a set of files, for writing the ceilings file. */
export function envCounts(files) {
  const counts = {};
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByEnvLint(path)) continue;
    const count = envReads(source).length;
    if (count) counts[path] = count;
  }
  return counts;
}

/**
 * Run the lint over a checkout. Off (the default) it reports nothing and reads nothing.
 *
 * @param {string} root - Checkout root.
 * @param {{enabled?: boolean}} [options] - `enabled` is gate.adapterLintEnv.
 * @returns {string[]} Findings, empty when the setting is off or no file passes its ceiling.
 */
export function envLintRows(root, { enabled = false } = {}) {
  if (enabled !== true) return [];
  let ceilings = {};
  try { ceilings = JSON.parse(readFileSync(join(root, ENV_CEILING_FILE), 'utf8')).files ?? {}; } catch { ceilings = {}; }
  const files = {};
  for (const path of walk(root, SOURCE_FILE)) if (coveredByEnvLint(path)) files[path] = readFileSync(join(root, path), 'utf8');
  return envFindings(files, ceilings);
}
