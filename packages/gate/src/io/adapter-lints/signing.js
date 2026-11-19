/**
 * Count node:crypto key and signature calls in source files outside the signing adapter, and refuse new ones [C7,#11270].
 * A source file signs and verifies through the signing adapter in packages/keys, so a test can hand it a fake one.
 * The offenders that exist today are held by a per-file ceiling that never rises; a file past its ceiling is a finding naming file, line and adapter.
 *
 * Why: scattered key calls tie every module to real keys, so the lint stops the count from growing while the routing
 * children move callers onto the adapter. Behind gate.adapterLintSigning, off by default: with it off the lint reports nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../scan.js';

/** The ceilings file: per-file counts of today's direct node:crypto key and signature calls, repo-relative. */
export const SIGNING_CEILING_FILE = 'packages/gate/data/ceilings/adapter-lint-signing.json';

const ADAPTER = 'packages/keys/src/io/adapter/signing.js';
const SOURCE_FILE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|bin)\/.*\.[cm]?js$/u;
const CRYPTO_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])node:crypto\2/gu;
const NAMES = new Set(['generateKeyPairSync', 'createPrivateKey', 'sign', 'verify']);

/** Whether a repo-relative path is a source file the lint covers: not the signing adapter, not a test. */
export const coveredBySigningLint = path => SOURCE_FILE.test(path) && path !== ADAPTER
  && !/(?:^|\/)tests?\//u.test(path) && !/[-_.]test\.[cm]?js$/u.test(path);

/** The local names a file imports from node:crypto for the four calls: `{ sign as s }` makes `s` count as sign. */
function importedNames(source) {
  const local = new Set();
  for (const match of source.matchAll(CRYPTO_IMPORT)) {
    for (const part of match[1].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/u);
      if (NAMES.has(name)) local.add(alias ?? name);
    }
  }
  return local;
}

/**
 * Every node:crypto generateKeyPairSync, createPrivateKey, sign or verify call in one file's text, one row per call, skipping
 * lines that are only comments. A call counts only when its name is imported from node:crypto in the same file, so
 * `x.verify(` and a call named inside a string are not counted.
 *
 * @param {string} source - File text.
 * @returns {{line: number, call: string}[]} Rows in line order.
 */
export function signingCalls(source) {
  const names = importedNames(source);
  if (!names.size) return [];
  const rows = [];
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('import')) return;
    for (const name of names) {
      for (const match of text.matchAll(new RegExp(`(?<![\\w$.'"\`])${name}\\s*\\(`, 'gu'))) rows.push({ line: index + 1, call: `${name}(`, at: match.index });
    }
  });
  return rows.sort((a, b) => a.line - b.line || a.at - b.at).map(({ line, call }) => ({ line, call }));
}

/**
 * The findings of the lint over a set of files: each file whose count passes its ceiling reports every call, with the adapter to use.
 *
 * @param {Record<string, string>} files - Repo-relative path to text.
 * @param {Record<string, number>} [ceilings] - Per-file counts that may not rise; a file not listed holds zero.
 * @returns {string[]} `path:line: ...` rows, sorted.
 */
export function signingFindings(files, ceilings = {}) {
  const rows = [];
  for (const [path, source] of Object.entries(files)) {
    if (!coveredBySigningLint(path)) continue;
    const calls = signingCalls(source);
    if (calls.length <= (ceilings[path] ?? 0)) continue;
    for (const called of calls) rows.push(`${path}:${called.line}: ${called.call} calls node:crypto outside the signing adapter (${calls.length} in this file, ceiling ${ceilings[path] ?? 0}); use the signing adapter in packages/keys/src/io/adapter/signing.js`);
  }
  return rows.sort();
}

/** The per-file counts for a set of files, for writing the ceilings file. */
export function signingCounts(files) {
  const counts = {};
  for (const [path, source] of Object.entries(files)) {
    if (!coveredBySigningLint(path)) continue;
    const count = signingCalls(source).length;
    if (count) counts[path] = count;
  }
  return counts;
}

/**
 * Run the lint over a checkout. Off (the default) it reports nothing and reads nothing.
 *
 * @param {string} root - Checkout root.
 * @param {{enabled?: boolean}} [options] - `enabled` is gate.adapterLintSigning.
 * @returns {string[]} Findings, empty when the setting is off or no file passes its ceiling.
 */
export function signingLintRows(root, { enabled = false } = {}) {
  if (enabled !== true) return [];
  let ceilings = {};
  try { ceilings = JSON.parse(readFileSync(join(root, SIGNING_CEILING_FILE), 'utf8')).files ?? {}; } catch { ceilings = {}; }
  const files = {};
  for (const path of walk(root, SOURCE_FILE)) if (coveredBySigningLint(path)) files[path] = readFileSync(join(root, path), 'utf8');
  return signingFindings(files, ceilings);
}
