/** Local delivery state and real Git observations for the existing inbox [R2,N26]. */
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gitPath } from '../../../../src/git.js';
import { checkoutHead } from '../../../git/index.js';
import { gitExecFileSync } from '../../../git/index.js';
import { statusPaths } from '../../../git/index.js';
import { worktreeStatus } from '../../../git/index.js';
import { agentSessionDigest } from '../../../person/index.js';
import { parseSpec } from '../../../spec/index.js';

/** Damaged or foreign local cursors replay activity instead of discarding unseen obligations. */
export function readActivityCursor(root, agent, board) {
  const file = gitPath(root, 'pullboard-activity.json');
  const session = agentSessionDigest();
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* First delivery or damaged local state replays safely. */ }
  const valid = saved?.version === 1 && saved.agent === agent && saved.board === board
    && [saved.after, saved.newsAfter].every(value => Number.isSafeInteger(value) && value >= 0);
  return { file, agent, board, session, after: valid ? saved.after : 0, newsAfter: valid ? saved.newsAfter : 0,
    sessionStart: !valid || saved.session !== session };
}

/** Save only after producing a complete response; failure keeps replay available and never hides it. */
export function saveActivityCursor(state, cursor) {
  const temporary = `${state.file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, agent: state.agent, board: state.board, session: state.session,
      after: cursor, newsAfter: state.sessionStart ? cursor : state.newsAfter }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, state.file);
    return true;
  } catch {
    try { rmSync(temporary); } catch { /* Only this invocation's own temporary file is removed. */ }
    return false;
  }
}

/** Read NUL-delimited paths without trimming or interpreting quoted/newline file names. */
function gitPaths(root, args) {
  return gitExecFileSync(['--no-optional-locks', '--no-replace-objects', '-c', 'core.quotepath=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
}

/**
 * Name the paths that differ across many tree-ish pairs with one `git diff-tree --stdin` process.
 * Why: one `git diff` process per pair cost 11-23 ms each, 631 ms on a board with 38 claimed items (#3252).
 * Returns every path in Git's order with the per-pair header (the first tree-ish's id) removed; a pair Git cannot read throws.
 */
function diffTreePaths(root, pairs, ...flags) {
  const out = gitExecFileSync(['--no-optional-locks', '--no-replace-objects', '-c', 'core.quotepath=false', 'diff-tree', '--stdin', '-r',
    '--no-ext-diff', '--no-textconv', '--name-only', '-z', ...flags],
  { cwd: root, encoding: 'utf8', input: pairs.map(pair => pair.join(' ')).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] });
  const headers = new Set(pairs.map(pair => pair[0]));
  return out.split('\0').filter(token => token && !(headers.has(token)));
}

/**
 * The paths each landed commit changed against its base, for many (commit, base) pairs in one Git process.
 * Why: the inbox projects one main-moved event per landing; each read its own `git diff` (#3252). A pair whose
 * base another pair shares (Git names each pair's output by its base), or that Git cannot read, is left out and falls back to the single-pair read.
 *
 * @param {string} root
 * @param {{ commit: string, base: string }[]} pairs
 * @returns {Map<string, string[]>} paths by `base commit`
 */
export function batchMainFiles(root, pairs) {
  const valid = pairs.filter(pair => [pair.commit, pair.base].every(value => /^[a-f0-9]{40}$/u.test(value ?? '')));
  const counts = new Map();
  for (const pair of valid) counts.set(pair.base, (counts.get(pair.base) ?? 0) + 1);
  const unique = valid.filter(pair => counts.get(pair.base) === 1);
  const found = new Map();
  if (unique.length < 2) return found;
  let out;
  try {
    out = gitExecFileSync(['--no-optional-locks', '--no-replace-objects', '-c', 'core.quotepath=false', 'diff-tree', '--stdin', '-r',
      '--no-ext-diff', '--no-textconv', '-M', '--name-only', '-z'],
    { cwd: root, encoding: 'utf8', input: unique.map(pair => `${pair.base} ${pair.commit}`).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'] }).split('\0');
  } catch { return found; }
  const byBase = new Map(unique.map(pair => [pair.base, pair]));
  for (const pair of unique) found.set(`${pair.base} ${pair.commit}`, []);
  let current = null;
  for (const token of out) {
    if (!token) continue;
    if (byBase.has(token)) current = found.get(`${token} ${byBase.get(token).commit}`);
    else current?.push(token);
  }
  return found;
}

/** Obtain declared-claim and real current diffs; unavailable ancestry stays explicitly unknown. */
export function activityWorkingFiles(root, builds) {
  if (!builds.length) return [];
  const files = new Set();
  let unknown = false;
  // One status gives the edits against HEAD and the untracked files, and other readers in this command share it.
  try {
    const { changed, untracked } = statusPaths(worktreeStatus(root));
    for (const path of [...changed, ...untracked]) files.add(path);
  } catch { unknown = true; }
  const head = checkoutHead(root);
  const bases = [];
  for (const base of new Set(builds.map(item => item.item_claim_head))) {
    if (!/^[a-f0-9]{40}$/u.test(base ?? '')) { unknown = true; continue; }
    // No commit since the claim's base: its committed changes are empty, with no Git process to say so.
    if (base !== head) bases.push(base);
  }
  // Every base's committed changes join one set, so one Git process names them all; a base Git cannot read
  // sends the set back to one diff per base, where only that base is unknown.
  if (bases.length) {
    try { for (const path of diffTreePaths(root, bases.map(base => [base, head]), '--no-renames')) files.add(path); }
    catch {
      for (const base of bases) {
        try { for (const path of gitPaths(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, 'HEAD'])) files.add(path); } catch { unknown = true; }
      }
    }
  }
  return { files: [...files], unknown };
}

/** Compare exactly the recorded landing base and tip; a missing object is unknown, never zero. */
export function activityMainFiles(root, commit, detail, { rowFiles = [], batch = null } = {}) {
  if (![commit, detail.base].every(value => /^[a-f0-9]{40}$/u.test(value ?? ''))) return null;
  let files = batch?.get(`${detail.base} ${commit}`);
  if (!files) try { files = gitPaths(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', detail.base, commit]); } catch { return null; }
  const rows = new Set();
  let unknownRows = false;
  for (const file of new Set(rowFiles.filter(file => files.includes(file)))) {
    try {
      const before = committedRows(root, detail.base, file);
      const after = committedRows(root, commit, file);
      for (const id of new Set([...before.keys(), ...after.keys()])) if (before.get(id) !== after.get(id)) rows.add(id);
    } catch { unknownRows = true; }
  }
  return { files, rows: [...rows], unknownRows };
}

/** Compare parsed row content, not line numbers shifted by another row's insertion. */
function committedRows(root, commit, file) {
  const args = ['--no-optional-locks', '--no-replace-objects', 'show', `${commit}:${file}`];
  let source;
  try { source = gitExecFileSync(args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch {
    // A deleted/new configured file has no rows on that side; other read failures remain unknown.
    const listing = gitPaths(root, ['ls-tree', '-z', '--name-only', commit, '--', file]);
    if (listing.length) throw new Error('the committed row file could not be read');
    return new Map();
  }
  const parsed = parseSpec(source);
  if (parsed.problems.length) throw new Error('the committed row file could not be parsed');
  return new Map(parsed.rows.map(({ line, ...row }) => [row.id, JSON.stringify(row)]));
}
