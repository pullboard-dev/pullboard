/** Read immutable object-backed cells snapshots without creating a Git worktree [C7]. */
import {
  git as realGit,
  tryGit as realTryGit,
  gitChildEnv,
} from '../packages/git/index.js';
import { machineHome } from '../packages/resources/index.js';
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
} from '../packages/codemap/index.js';
import { cellSourceSnapshot } from '../packages/codemap/index.js';
export { withCellSourceSnapshots } from '../packages/codemap/index.js';

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
  const pinned = args.map(argument => argument.replace(/^HEAD(?=$|[~^:])/u, snapshot.commit));
  return realGit(snapshot.repoRoot, pinned, { ...options, env: cellGitEnvironment(root, options?.env) });
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
