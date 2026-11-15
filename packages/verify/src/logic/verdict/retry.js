/** A retry checks an immutable merge object without changing the reviewer's checkout or the submitted item [V4,V8]. */
import { mergeManifestRows } from '../../../../merge/index.js';
import { mergePlanData } from '../../../../merge/index.js';
import { mergeableData } from '../../../../merge/index.js';
import { rowManifest } from '../../../../merge/index.js';
import {
  gitExecFileSync,
  cleanGitEnvironment,
  git,
  tryGit,
} from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';

/** Read or write immutable Git objects with byte-preserving framing and no candidate hooks. */
function objectGit(root, args, input) {
  return gitExecFileSync(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: root, env: cleanGitEnvironment(), encoding: null, maxBuffer: 32 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
}

/** Replace one known manifest blob while retaining every other tree-entry byte, including unusual filenames. */
function replaceBlob(root, tree, parts, blob, mode) {
  const raw = objectGit(root, ['ls-tree', '-z', tree]);
  const entries = [];
  for (let start = 0, end; (end = raw.indexOf(0, start)) !== -1; start = end + 1) entries.push(raw.subarray(start, end));
  let found = false;
  const changed = entries.map(entry => {
    const tab = entry.indexOf(9), name = entry.subarray(tab + 1);
    if (!name.equals(Buffer.from(parts[0]))) return entry;
    const header = /^(\d+) (tree|blob) ([a-f0-9]+)$/u.exec(entry.subarray(0, tab).toString('ascii'));
    if (!header || parts.length > 1 && header[2] !== 'tree') throw new Refused('MERGE_CHECK_FAILED', 'restore the exact manifest tree entry before retrying review');
    found = true;
    const hash = parts.length === 1 ? blob : replaceBlob(root, header[3], parts.slice(1), blob, mode);
    return Buffer.concat([Buffer.from(`${parts.length === 1 ? mode : header[1]} ${parts.length === 1 ? 'blob' : 'tree'} ${hash}\t`), name]);
  });
  if (!found) throw new Refused('MERGE_CHECK_FAILED', 'the conflicted manifest is missing from the immutable merge tree');
  return objectGit(root, ['mktree', '-z'], Buffer.concat(changed.flatMap(entry => [entry, Buffer.from([0])]))).toString('ascii').trim();
}

/** Resolve only the two named data manifests; ordinary source conflicts remain named refusals. */
function manifestTree(root, fields) {
  const end = fields.indexOf('', 1), records = new Map();
  for (const field of fields.slice(1, end < 0 ? undefined : end)) {
    const row = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/u.exec(field);
    if (!row) throw new Refused('MERGE_CHECK_FAILED', 'Git did not return complete manifest conflict stages');
    if (!records.has(row[4])) records.set(row[4], []);
    records.get(row[4]).push({ mode: row[1], hash: row[2], stage: Number(row[3]) });
  }
  const paths = [...records.keys()].sort();
  if (!paths.length || paths.some(path => !mergeableData(path))) throw new Refused('MERGE_CONFLICT',
    `the review cannot form a clean merge with current main; conflicts: ${paths.map(path => JSON.stringify(path)).join(', ')}; resolve, commit and resubmit`);
  const resolved = paths.map(path => {
    const rows = records.get(path);
    if (rows.length !== 3 || rows.some((row, index) => row.stage !== index + 1 || row.mode !== rows[0].mode)
      || !['100644', '100755'].includes(rows[0].mode)) throw new Refused('MERGE_CONFLICT', `manifest file mode or deletion conflicts at ${path}`);
    const sources = rows.map(row => objectGit(root, ['cat-file', 'blob', row.hash]));
    if (sources.some(source => !Buffer.from(source.toString('utf8'), 'utf8').equals(source))) throw new Refused('MERGE_CONFLICT', `manifest encoding conflicts at ${path}`);
    const texts = sources.map(source => source.toString('utf8'));
    const merged = rowManifest(path) ? mergeManifestRows(path, ...texts) : mergePlanData(path, ...texts);
    if (merged.conflicts) throw new Refused('MERGE_CONFLICT', `${path}: ${merged.conflicts.join(', ')}`);
    return { path, mode: rows[0].mode, source: merged.source };
  });
  let tree = fields[0];
  for (const entry of resolved) {
    const blob = objectGit(root, ['hash-object', '-w', '--stdin'], entry.source).toString('ascii').trim();
    tree = replaceBlob(root, tree, entry.path.split('/'), blob, entry.mode);
  }
  return tree;
}

/**
 * Create the exact clean composition for the one mid-check retry. Git object writes cannot execute candidate hooks.
 * Ordinary merge conflicts stay refusals; no generated or guessed conflict resolution enters a review.
 *
 * @param {string} root
 * @param {string} checkedCommit
 * @param {{ ref: string, commit: string }} trunk
 * @returns {string}
 */
export function retryReviewCommit(root, checkedCommit, trunk) {
  if (tryGit(root, ['config', '--get-regexp', '^merge\\..*\\.driver$'], { env: cleanGitEnvironment() }).stdout)
    throw new Refused('MERGE_CHECK_FAILED', 'external merge drivers cannot establish an immutable review composition');
  const merge = tryGit(root, ['merge-tree', '--write-tree', '-z', trunk.commit, checkedCommit], { env: cleanGitEnvironment() });
  const fields = merge.stdout.split('\0');
  if (![0, 1].includes(merge.status)) throw new Refused('MERGE_CHECK_FAILED', 'Git could not compute the immutable review merge');
  const tree = merge.status === 0 ? fields[0].trim() : manifestTree(root, fields);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) throw new Refused('MERGE_CHECK_FAILED', 'Git did not return a readable retry merge tree; restore its objects and retry verification');
  const env = { ...cleanGitEnvironment(), GIT_AUTHOR_NAME: 'Pullboard review', GIT_AUTHOR_EMAIL: 'review@pullboard.invalid',
    GIT_COMMITTER_NAME: 'Pullboard review', GIT_COMMITTER_EMAIL: 'review@pullboard.invalid' };
  return git(root, ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', trunk.commit, '-p', checkedCommit,
    '-m', 'chore(review): compose the bounded verification retry [V4,V8]'], { env });
}
