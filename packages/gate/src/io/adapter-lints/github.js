/**
 * Count direct GitHub API references in source files outside the GitHub adapter, and refuse new ones [C7,#1429].
 * A source file reaches GitHub through the GitHub adapter in packages/github, so a test can hand it a fake one.
 * The offenders that exist today are held by a per-file ceiling that never rises; a file past its ceiling is a finding naming file, line and adapter.
 *
 * Why: scattered GitHub API addresses tie every module to the real network, so the lint stops the count from growing while the routing
 * children move callers onto the adapter. Behind gate.adapterLintGithub, off by default: with it off the lint reports nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../scan.js';

/** The ceilings file: per-file counts of today's direct GitHub API references, repo-relative. */
export const GITHUB_CEILING_FILE = 'packages/gate/data/ceilings/adapter-lint-github.json';

const ADAPTER_FOLDER = 'packages/github/src/io/adapter/';
const SOURCE_FILE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|bin)\/.*\.[cm]?js$/u;
const GITHUB_REFERENCE = /api\.github\.com|GITHUB_API_URL|PULLBOARD_GITHUB_API/u;

/** Whether a repo-relative path is a source file the lint covers: not the GitHub adapter, not a test. */
export const coveredByGithubLint = path => SOURCE_FILE.test(path) && !path.startsWith(ADAPTER_FOLDER)
  && !/(?:^|\/)tests?\//u.test(path) && !/[-_.]test\.[cm]?js$/u.test(path);

/**
 * Every line of one file's text that names the GitHub API address or one of its two address variables, skipping lines that are only comments.
 *
 * @param {string} source - File text.
 * @returns {{line: number, reference: string}[]} One row per line, in line order.
 */
export function githubReferences(source) {
  const rows = [];
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const match = GITHUB_REFERENCE.exec(text);
    if (match) rows.push({ line: index + 1, reference: match[0] });
  });
  return rows;
}

/**
 * The findings of the lint over a set of files: each file whose count passes its ceiling reports every reference, with the adapter to use.
 *
 * @param {Record<string, string>} files - Repo-relative path to text.
 * @param {Record<string, number>} [ceilings] - Per-file counts that may not rise; a file not listed holds zero.
 * @returns {string[]} `path:line: ...` rows, sorted.
 */
export function githubFindings(files, ceilings = {}) {
  const rows = [];
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByGithubLint(path)) continue;
    const references = githubReferences(source);
    if (references.length <= (ceilings[path] ?? 0)) continue;
    for (const found of references) rows.push(`${path}:${found.line}: ${found.reference} reaches GitHub outside the GitHub adapter (${references.length} in this file, ceiling ${ceilings[path] ?? 0}); use the GitHub adapter in packages/github/src/io/adapter/request.js`);
  }
  return rows.sort();
}

/** The per-file counts for a set of files, for writing the ceilings file. */
export function githubCounts(files) {
  const counts = {};
  for (const [path, source] of Object.entries(files)) {
    if (!coveredByGithubLint(path)) continue;
    const count = githubReferences(source).length;
    if (count) counts[path] = count;
  }
  return counts;
}

/**
 * Run the lint over a checkout. Off (the default) it reports nothing and reads nothing.
 *
 * @param {string} root - Checkout root.
 * @param {{enabled?: boolean}} [options] - `enabled` is gate.adapterLintGithub.
 * @returns {string[]} Findings, empty when the setting is off or no file passes its ceiling.
 */
export function githubLintRows(root, { enabled = false } = {}) {
  if (enabled !== true) return [];
  let ceilings = {};
  try { ceilings = JSON.parse(readFileSync(join(root, GITHUB_CEILING_FILE), 'utf8')).files ?? {}; } catch { ceilings = {}; }
  const files = {};
  for (const path of walk(root, SOURCE_FILE)) if (coveredByGithubLint(path)) files[path] = readFileSync(join(root, path), 'utf8');
  return githubFindings(files, ceilings);
}
