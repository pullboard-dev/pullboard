/**
 * Gate analysis on an item's changed files, once per item head [5814]. The static and doctrine parts of a gate judge only
 * the paths an item changed against main, unless a changed path is an input every rule reads; and a green part is kept
 * under the candidate's tree, its change against main and main's checker code, so a resubmit of the same head reuses it.
 * Why: remote analysis was 19% of a green gate and reran on every resubmit.
 */
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../../fs/index.js';
import { join } from 'node:path';
import { tryGit } from '../../../../git/index.js';
import { machineHome } from '../../../../resources/index.js';
import { environmentAdapter } from '../../../../env/index.js';
import { storeName } from '../store-names.js';

/** Every file read and write goes through the file-system adapter [C7]. */
const fs = fileSystemAdapter();

/** The environment variable that hands a static command the changed paths, as a JSON list; a command that ignores it runs whole. */
export const STATIC_SCOPE_ENV = 'PULLBOARD_STATIC_SCOPE';

/**
 * Paths every whole-repo rule reads: project config, the doctrine, and any JSON file (baselines, ceilings, plans and
 * listings are all JSON). A change to one runs the whole static check.
 */
const WHOLE_REPO_INPUT = /^(?:pullboard\.json|package\.json|DOCTRINE\.md)$|\.json$/u;

/** The packages and folders main's checkers run from; a change to their tree on main retires every kept result. */
const TOOLING = ['packages/gate', 'packages/codemap', 'packages/doctrine', 'packages/kernel', 'packages/git', 'packages/config', 'packages/state', 'apps/cli/src/io/static'];

/**
 * Decide what a static or doctrine part judges for one change.
 *
 * @param {{path: string, status: string}[]} changes - The change against main, one row per path, `status` as git's raw letter.
 * @returns {{full: false, files: string[]} | {full: true, reason: string}} `files` when every rule may judge only them.
 */
export function analysisScope(changes) {
  for (const { path, status } of changes) {
    if (status === 'D') return { full: true, reason: `${path} was deleted, and rules read which paths exist` };
    if (WHOLE_REPO_INPUT.test(path)) return { full: true, reason: `${path} is an input every rule reads` };
  }
  return { full: false, files: changes.map(change => change.path).sort() };
}

/** Run git in a checkout and return its stdout, or null when it fails. */
function gitText(root, args) {
  const ran = tryGit(root, ['--no-replace-objects', ...args]);
  return ran.status === 0 ? ran.stdout : null;
}

/**
 * The item's change, read once: what the candidate changed since it left main (its merge base, a tree main held green),
 * each path's status, and the raw rows of those paths against current main (both blob ids per path), which a kept doctrine
 * hold is keyed by: main moving under a changed path changes them, main moving elsewhere does not.
 *
 * @param {string} root - A checkout holding both commits.
 * @param {string} main - Accepted main's commit.
 * @param {string} source - The candidate commit.
 * @returns {{raw: string, mainRaw: string, changes: {path: string, status: string}[]} | null} Null when git cannot say.
 */
export function analysisChange(root, main, source) {
  const base = gitText(root, ['merge-base', main, source])?.trim();
  const raw = base ? gitText(root, ['diff', '--raw', '--no-renames', '-z', '--no-abbrev', base, source, '--']) : null;
  const mainRaw = raw === null ? null : gitText(root, ['diff', '--raw', '--no-renames', '-z', '--no-abbrev', main, source, '--']);
  if (raw === null || mainRaw === null) return null;
  const rows = text => { const fields = text.split('\0'), found = []; for (let at = 0; at + 1 < fields.length; at += 2) found.push({ row: fields[at].trim(), path: fields[at + 1] }); return found; };
  const changes = rows(raw).map(({ row, path }) => ({ status: row.split(/\s+/u).at(-1), path }));
  const paths = new Set(changes.map(change => change.path));
  return { raw, mainRaw: rows(mainRaw).filter(({ path }) => paths.has(path)).map(({ row, path }) => `${row}\t${path}`).join('\n'), changes };
}

/**
 * The key a green part is kept under: the candidate's tree, a raw change (against current main for a doctrine hold, so main
 * moving under a changed path retires it) and the trees of main's checker code, plus the part's own definition. Null when git cannot say.
 *
 * @param {string} root - A checkout holding both commits.
 * @param {{kind: string, main: string, source: string, raw: string, definition?: unknown, mainPaths?: string[]}} part - `mainPaths`: more
 *   files or folders of main the part reads, such as the doctrine file.
 * @returns {string | null}
 */
export function analysisKey(root, { kind, main, source, raw, definition = null, mainPaths = [] }) {
  const read = [...TOOLING, ...mainPaths];
  const trees = gitText(root, ['rev-parse', `${source}^{tree}`, ...read.map(path => `${main}:${path}`)]);
  // A path main lacks fails rev-parse; the ids are then read one at a time, a missing one as empty.
  const ids = trees?.trim().split('\n') ?? [gitText(root, ['rev-parse', `${source}^{tree}`])?.trim() ?? '', ...read.map(path => gitText(root, ['rev-parse', `${main}:${path}`])?.trim() ?? '')];
  if (!ids[0]) return null;
  return createHash('sha256').update(JSON.stringify([1, kind, ids, raw, definition])).digest('hex');
}

/** The file a kept result lives in, under the machine home so every job on one runner shares it. */
function memoFile(key, home) {
  return join(home ?? join(machineHome(), 'analysis-memo'), storeName(key));
}

/**
 * A kept green result for exactly this key, or null.
 *
 * @param {string | null} key
 * @param {{home?: string}} [options]
 */
export function readAnalysisMemo(key, { home } = {}) {
  if (!key) return null;
  try {
    const kept = JSON.parse(fs.readFile(memoFile(key, home), 'utf8'));
    return kept.version === 1 && kept.key === key ? kept : null;
  } catch { return null; }
}

/**
 * Keep a green result under its key; a failed write only costs the next resubmit a rerun.
 *
 * @param {string | null} key
 * @param {unknown} result
 * @param {{home?: string}} [options]
 */
export function writeAnalysisMemo(key, result, { home } = {}) {
  if (!key) return null;
  const kept = { version: 1, key, at: new Date().toISOString(), result };
  try {
    const file = memoFile(key, home), temporary = `${file}.${process.pid}.tmp`;
    fs.mkdir(join(file, '..'), { recursive: true });
    fs.writeFile(temporary, JSON.stringify(kept));
    fs.rename(temporary, file);
  } catch { return null; }
  return kept;
}

/** The changed paths a static command was handed in its environment, or null for a whole-tree run. */
export function staticScopeFromEnv(env = environmentAdapter().all()) {
  try {
    const files = JSON.parse(env[STATIC_SCOPE_ENV] ?? 'null');
    return Array.isArray(files) && files.every(file => typeof file === 'string') ? files : null;
  } catch { return null; }
}
