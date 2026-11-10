/** Read immutable object-backed cells snapshots without creating a Git worktree [C7]. */
import {
  git as realGit,
  tryGit as realTryGit,
  gitChildEnv,
  gitSpawnSync,
} from '../../../../git/index.js';
import { machineHome } from '../../../../resources/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  join,
  resolve,
} from 'node:path';
import {
  readPathMap as committedPathMap,
  pathMapFromFiles,
} from '../../../index.js';
import { cellSourceSnapshot } from '../../../index.js';
export { withCellSourceSnapshots } from '../../../index.js';

const objectScopes = new AsyncLocalStorage();

/** Resolve virtual source roots to the repository that owns their Git objects. */
function repository(root) { return cellSourceSnapshot(root)?.repoRoot ?? root; }

/** Return sanitized Git environment with scoped object writes redirected into the machine cache. */
export function cellGitEnvironment(root, extra = {}) {
  const actual = repository(root), env = gitChildEnv(actual, { env: extra });
  const scope = objectScopes.getStore();
  if (scope && resolve(actual) === scope.repository) {
    env.GIT_OBJECT_DIRECTORY = scope.directory;
    // Git understands C-quoted paths here, including a colon that would otherwise split alternate entries.
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = JSON.stringify(scope.alternate);
  }
  return env;
}

/** Keep newly composed Git objects in a repository-specific machine-cache object directory. */
export async function withCellGitObjects(root, work) {
  if (typeof root !== 'string' || typeof work !== 'function') throw new TypeError('cells object scope needs a repository and action');
  const actual = resolve(repository(root));
  const existing = objectScopes.getStore();
  if (existing?.repository === actual) return work();
  const alternate = realpathSync(realGit(actual, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { env: gitChildEnv(actual) }));
  if (!statSync(alternate).isDirectory()) throw new Error('cells source object directory is unavailable');
  const key = createHash('sha256').update(alternate).digest('hex');
  const directory = join(machineHome(), 'cells-cache', 'objects', key);
  mkdirSync(join(directory, 'info'), { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'pack'), { recursive: true, mode: 0o700 });
  return objectScopes.run({ repository: actual, directory, alternate }, work);
}

/** Git's object type for one tree entry mode. */
const ENTRY_TYPES = { '100644': 'blob', '100755': 'blob', '120000': 'blob', '160000': 'commit' };

/**
 * Answer a read the snapshot already holds, or null to ask Git: `rev-parse HEAD` (or the pinned commit) and a
 * one-path `ls-tree -z <commit> -- <path>`. Why: the cells check asked Git these per touched cell, 129 of a
 * submit's 989 Git processes (#3896). A path that names a folder is left to Git, since entries hold only files.
 */
function snapshotAnswer(snapshot, args) {
  if (args.length === 2 && args[0] === 'rev-parse' && (args[1] === 'HEAD' || args[1] === snapshot.commit)) return snapshot.commit;
  if (args.length !== 5 || args[0] !== 'ls-tree' || args[1] !== '-z' || args[3] !== '--' || !['HEAD', snapshot.commit].includes(args[2])) return null;
  const path = args[4], entry = snapshot.entries.get(path);
  if (entry) return ENTRY_TYPES[entry.mode] && entry.object ? `${entry.mode} ${ENTRY_TYPES[entry.mode]} ${entry.object}\t${path}\0` : null;
  for (const file of snapshot.entries.keys()) if (file.startsWith(`${path}/`)) return null;
  return '';
}

/** Run only read operations at the actual repository, resolving virtual HEAD to its pinned commit. */
export function git(root, args, options) {
  const snapshot = cellSourceSnapshot(root);
  if (!snapshot) return realGit(root, args, { ...options, env: cellGitEnvironment(root, options?.env) });
  if (args[0] === 'status') return '';
  if (args[0] === 'ls-files') {
    const separator = args.includes('-z') ? '\0' : '\n';
    const paths = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
    const files = [...snapshot.entries.keys()].filter(file => !paths.length || paths.some(path => file === path || file.startsWith(path + '/'))).sort();
    if (args.includes('--error-unmatch') && !files.length) throw new Error('snapshot path is not tracked');
    return files.length ? files.join(separator) + separator : '';
  }
  if (!['rev-parse', 'ls-tree', 'diff', 'merge-base', 'log', 'rev-list', 'show', 'cat-file'].includes(args[0])) throw new Error(`cells snapshot cannot run Git ${args[0]}`);
  const answered = snapshotAnswer(snapshot, args);
  if (answered !== null) return answered;
  const pinned = args.map(argument => argument.replace(/^HEAD(?=$|[~^:])/u, snapshot.commit));
  return realGit(snapshot.repoRoot, pinned, { ...options, env: cellGitEnvironment(root, options?.env) });
}

/**
 * Read many blobs by object id in one `cat-file --batch` at the root's repository, as UTF-8 text by object; an object
 * Git lacks, or any failed or malformed batch, is simply absent. Why: one process per blob was most of the cells
 * check's Git time (#3896).
 */
export function readBlobs(root, objects) {
  const wanted = [...new Set(objects)].filter(object => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(object));
  const blobs = new Map();
  if (!wanted.length) return blobs;
  const result = gitSpawnSync(['--no-replace-objects', 'cat-file', '--batch'], { cwd: repository(root), env: cellGitEnvironment(root),
    input: `${wanted.join('\n')}\n`, maxBuffer: 256 * 1024 ** 2 });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return blobs;
  const out = result.stdout;
  let at = 0;
  for (const object of wanted) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) break;
    const [name, type, size] = out.toString('utf8', at, end).split(' ');
    if (name !== object) break;
    if (type === 'missing') { at = end + 1; continue; }
    const length = Number(size);
    if (!Number.isSafeInteger(length) || length < 0 || end + 1 + length > out.length) break;
    if (type === 'blob') blobs.set(object, out.toString('utf8', end + 1, end + 1 + length));
    at = end + 2 + length;
  }
  return blobs;
}

/** Preserve the native status/stdout contract for existing structural analyzers. */
export function tryGit(root, args, options) {
  if (!cellSourceSnapshot(root)) return realTryGit(root, args, { ...options, env: cellGitEnvironment(root, options?.env) });
  try { return { status: 0, stdout: git(root, args, options), stderr: '' }; }
  catch (error) { return { status: error.status ?? 1, stdout: '', stderr: error.message }; }
}

/** Read committed rename metadata from the pinned in-memory source, or preserve the native reader. */
export function readPathMap(root, options) {
  const snapshot = cellSourceSnapshot(root);
  return snapshot && (!options?.commit || options.commit === 'HEAD' || options.commit === snapshot.commit)
    ? pathMapFromFiles(snapshot.files, snapshot.entries) : committedPathMap(snapshot?.repoRoot ?? root, options);
}
