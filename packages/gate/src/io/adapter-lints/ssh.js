/**
 * Count direct spawns of the ssh binary in source files outside the SSH runner adapter, and refuse new ones [C7,#11374].
 * A source file reaches a runner over ssh through the SSH runner adapter in packages/runners, so a test can hand it a fake one.
 * The offenders that exist today are held by a per-file ceiling that never rises; a file past its ceiling is a finding naming file, line and adapter.
 *
 * Why: scattered ssh spawns tie every module to a real runner, so the lint stops the count from growing while the routing
 * children move callers onto the adapter. Behind gate.adapterLintSsh, off by default: with it off the lint reports nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk } from '../scan.js';

/** The ceilings file: per-file counts of today's direct ssh spawns, repo-relative. */
export const SSH_CEILING_FILE = 'packages/gate/data/ceilings/adapter-lint-ssh.json';

const ADAPTER = 'packages/runners/src/io/adapter/ssh.js';
const SOURCE_FILE = /^(?:apps\/[^/]+\/src|packages\/[^/]+\/src|bin)\/.*\.[cm]?js$/u;
const SPAWN_LITERAL = /(?<![\w$.])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|spawnFn)\s*\(\s*(['"`])ssh\1/gu;
const SPAWN_PARAMETER = /(?<![\w$.])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|spawnFn)\s*\(\s*ssh\s*[,)]/gu;
const SSH_DEFAULT = /\bssh\s*=\s*(['"`])ssh\1/u;

/** Whether a repo-relative path is a source file the lint covers: not the SSH runner adapter, not a test. */
export const coveredBySshLint = path => SOURCE_FILE.test(path) && path !== ADAPTER
  && !/(?:^|\/)tests?\//u.test(path) && !/[-_.]test\.[cm]?js$/u.test(path);

/**
 * Every direct ssh spawn in one file's text, one row per call, skipping lines that are only comments. A call counts when its
 * command is the literal 'ssh', or a parameter named ssh that the same file defaults to 'ssh'.
 *
 * @param {string} source - File text.
 * @returns {{line: number, call: string}[]} Rows in line order.
 */
export function sshSpawns(source) {
  const rows = [];
  const defaulted = SSH_DEFAULT.test(source);
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const match of text.matchAll(SPAWN_LITERAL)) rows.push({ line: index + 1, call: match[0].replace(/\s+/gu, '') });
    if (defaulted) for (const match of text.matchAll(SPAWN_PARAMETER)) rows.push({ line: index + 1, call: match[0].replace(/\s*[,)]$/u, '').replace(/\s+/gu, '') });
  });
  return rows.sort((a, b) => a.line - b.line);
}

/**
 * The findings of the lint over a set of files: each file whose count passes its ceiling reports every spawn, with the adapter to use.
 *
 * @param {Record<string, string>} files - Repo-relative path to text.
 * @param {Record<string, number>} [ceilings] - Per-file counts that may not rise; a file not listed holds zero.
 * @returns {string[]} `path:line: ...` rows, sorted.
 */
export function sshFindings(files, ceilings = {}) {
  const rows = [];
  for (const [path, source] of Object.entries(files)) {
    if (!coveredBySshLint(path)) continue;
    const spawns = sshSpawns(source);
    if (spawns.length <= (ceilings[path] ?? 0)) continue;
    for (const spawned of spawns) rows.push(`${path}:${spawned.line}: ${spawned.call} spawns ssh outside the SSH runner adapter (${spawns.length} in this file, ceiling ${ceilings[path] ?? 0}); use the SSH runner adapter in packages/runners/src/io/adapter/ssh.js`);
  }
  return rows.sort();
}

/** The per-file counts for a set of files, for writing the ceilings file. */
export function sshCounts(files) {
  const counts = {};
  for (const [path, source] of Object.entries(files)) {
    if (!coveredBySshLint(path)) continue;
    const count = sshSpawns(source).length;
    if (count) counts[path] = count;
  }
  return counts;
}

/**
 * Run the lint over a checkout. Off (the default) it reports nothing and reads nothing.
 *
 * @param {string} root - Checkout root.
 * @param {{enabled?: boolean}} [options] - `enabled` is gate.adapterLintSsh.
 * @returns {string[]} Findings, empty when the setting is off or no file passes its ceiling.
 */
export function sshLintRows(root, { enabled = false } = {}) {
  if (enabled !== true) return [];
  let ceilings = {};
  try { ceilings = JSON.parse(readFileSync(join(root, SSH_CEILING_FILE), 'utf8')).files ?? {}; } catch { ceilings = {}; }
  const files = {};
  for (const path of walk(root, SOURCE_FILE)) if (coveredBySshLint(path)) files[path] = readFileSync(join(root, path), 'utf8');
  return sshFindings(files, ceilings);
}
