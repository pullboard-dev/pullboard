/**
 * What git history holds the spec to (S8). Ids are permanent: every id that was ever committed to
 * the spec, and every id a commit cites, must still be there, so a commit or an item that cites a
 * row keeps its meaning however the spec changes.
 */
import { spawnSync } from './windows-child-process.js';
import { parseCommitMessage } from './commit-message.js';
import {
  ID_RE,
  parseSpec,
} from './spec.js';

/**
 * Run git for output that can be large, or null when it fails.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {string | null}
 */
function gitOut(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Every committed version of a file reachable from `revs` (HEAD by default), newest first: the
 * commit, and the file's whole text after it. Renames are followed. One git process, however long
 * the history.
 *
 * @param {string} root
 * @param {string} path
 * @param {string[]} [revs]
 * @returns {{ commit: string, text: string }[]}
 */
export function fileVersions(root, path, revs = ['HEAD']) {
  const out = gitOut(root, [
    'log', '--follow', '--format=%x00%H', '-p', '--unified=1000000',
    '--no-color', '--no-ext-diff', '--no-textconv', ...revs, '--', path,
  ]);
  if (!out) return [];
  return out.split('\0').filter((chunk) => chunk.trim()).map((chunk) => {
    const [commit = '', ...lines] = chunk.split('\n');
    const hunk = lines.findIndex((line) => line.startsWith('@@'));
    const after = hunk === -1 ? [] : lines.slice(hunk + 1).filter((line) => line.startsWith(' ') || line.startsWith('+'));
    return { commit: commit.trim(), text: after.map((line) => line.slice(1)).join('\n') };
  });
}

/**
 * Every id ever committed to a spec file, with the commit that first had it.
 *
 * @param {string} root
 * @param {string} path
 * @param {string[]} [revs] - the history to walk; HEAD's by default.
 * @returns {{ ids: Map<string, string>, since: string | null }} `since` is the file's first commit.
 */
export function committedIds(root, path, revs = ['HEAD']) {
  const versions = fileVersions(root, path, revs);
  const ids = new Map();
  for (const { commit, text } of versions) {
    for (const row of parseSpec(text, { strictGrammarVersion: false }).rows) ids.set(row.id, commit);
  }
  return { ids, since: versions.at(-1)?.commit ?? null };
}

/**
 * The complete spec citations from `since` (the spec's first commit) to HEAD, each with the newest
 * commit that cites it. Final row trailers take priority over header previews; legacy commits fall
 * back to their named header rows. Commits older than the spec cite nothing it could hold.
 *
 * @param {string} root
 * @param {string} since
 * @returns {Map<string, string>}
 */
export function commitCitations(root, since) {
  const out = [
    gitOut(root, ['log', '--format=%h%x00%B%x00', `${since}..HEAD`]),
    gitOut(root, ['log', '-1', '--format=%h%x00%B%x00', since]),
  ].join('\n');
  const cited = new Map();
  // Git commit messages cannot contain NUL, so body lines and tabs cannot forge record boundaries.
  const records = out.split('\0');
  for (let index = 0; index + 1 < records.length; index += 2) {
    const short = records[index].trim();
    if (!short) continue;
    const parsed = parseCommitMessage(records[index + 1]);
    for (const id of (parsed.rows ?? parsed.shown).filter((entry) => ID_RE.test(entry))) {
      if (!cited.has(id)) cited.set(id, `commit ${short}`);
    }
  }
  return cited;
}
