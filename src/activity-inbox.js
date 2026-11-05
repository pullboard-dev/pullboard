/** Local delivery state and real Git observations for the existing inbox [R2,N26]. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from './windows-child-process.js';
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gitPath } from './git.js';
import { agentSessionDigest } from './person.js';
import { parseSpec } from './spec.js';

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
  return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.quotepath=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
}

/** Obtain declared-claim and real current diffs; unavailable ancestry stays explicitly unknown. */
export function activityWorkingFiles(root, builds) {
  if (!builds.length) return [];
  const files = new Set();
  let unknown = false;
  const commands = [['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD'],
    ['ls-files', '-z', '--others', '--exclude-standard']];
  for (const base of new Set(builds.map(item => item.item_claim_head))) {
    if (!/^[a-f0-9]{40}$/u.test(base ?? '')) { unknown = true; continue; }
    commands.push(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, 'HEAD']);
  }
  for (const args of commands) {
    try { for (const path of gitPaths(root, args)) files.add(path); } catch { unknown = true; }
  }
  return { files: [...files], unknown };
}

/** Compare exactly the recorded landing base and tip; a missing object is unknown, never zero. */
export function activityMainFiles(root, commit, detail, { rowFiles = [] } = {}) {
  if (![commit, detail.base].every(value => /^[a-f0-9]{40}$/u.test(value ?? ''))) return null;
  let files;
  try { files = gitPaths(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', detail.base, commit]); } catch { return null; }
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
  try { source = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
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
