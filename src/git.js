/**
 * The few git facts pullboard needs: where the repo is, which worktree this is, what HEAD holds,
 * and whether the tree is clean. Every call is a plain `git` child process.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Refused } from './refused.js';

const GIT_FLAGS = ['--no-replace-objects', '-c', 'core.quotepath=false'];

/** Clear inherited Git selectors while retaining ordinary user settings and exact-object behavior.
 *
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE']) delete env[key];
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_/.test(key)) delete env[key];
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

/** Resolve the primary checkout's branch and commit without assuming its branch is named main.
 *
 * @param {string} root
 * @returns {{branch: string, commit: string|null}|null}
 */
export function mainCheckout(root) {
  const env = cleanGitEnvironment();
  /** Run one Git lookup with the sanitized environment. */
  const gitCall = (args) => spawnSync('git', [...GIT_FLAGS, ...args], {
    cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const common = gitCall(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.status !== 0) throw new Refused('NO_POLICY', 'the primary checkout cannot be located; restore the repository and ask the coordinator to retry');
  const commonDir = common.stdout.trim();
  const symbolic = gitCall(['--git-dir', commonDir, 'symbolic-ref', '--quiet', 'HEAD']);
  if (symbolic.status === 1) return null;
  if (symbolic.status !== 0) throw new Refused('NO_POLICY', 'the primary checkout branch cannot be read; restore its Git metadata and ask the coordinator to retry');
  const branch = symbolic.stdout.trim();
  const resolved = gitCall(['--git-dir', commonDir, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  if (resolved.status !== 0 && resolved.status !== 1) throw new Refused('NO_POLICY', 'the primary checkout commit cannot be read; restore its Git objects and ask the coordinator to retry');
  return { branch, commit: resolved.status === 0 ? resolved.stdout.trim() : null };
}

/**
 * The environment for a gate or fixer: keep the user's settings, but remove Git's repository-local
 * variables so a child that changes folders cannot act on the hook's repository by accident.
 * Pullboard's own Git calls retain those variables, including a hook's staged index.
 *
 * @param {string} root
 * @returns {NodeJS.ProcessEnv}
 */
export function gitChildEnv(root) {
  const env = { ...process.env };
  for (const name of git(root, ['rev-parse', '--local-env-vars']).split('\n')) delete env[name];
  env.GIT_NO_REPLACE_OBJECTS = '1'; // Exact-tree receipts must never resolve replacement refs.
  return env;
}

/**
 * Run git in `cwd` and return its trimmed output, or throw when git fails.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ maxBuffer?: number }} [options] - Bound output captures for callers parsing larger diffs.
 * @returns {string}
 */
export function git(cwd, args, { maxBuffer } = {}) {
  return execFileSync('git', [...GIT_FLAGS, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  }).trim();
}

/**
 * Run git in `cwd` and report how it went, without throwing.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number, stdout: string }}
 */
export function tryGit(cwd, args) {
  const result = spawnSync('git', [...GIT_FLAGS, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: (result.stdout ?? '').trim() };
}

/**
 * Find a main checkout whose `.git/config` marks it bare despite files beside its git directory.
 * This check uses the filesystem and explicit config path so inherited Git repository variables
 * cannot hide a damaged checkout from the command that needs to explain its repair.
 *
 * @param {string} cwd
 * @returns {{ code: string, message: string, next: string } | null}
 */
export function bareWorktreeFinding(cwd) {
  let root = resolve(cwd);
  while (true) {
    const gitDir = join(root, '.git');
    if (existsSync(gitDir)) {
      try {
        if (!statSync(gitDir).isDirectory()) return null;
        if (readdirSync(root).some((entry) => entry !== '.git')) {
          const bare = tryGit(root, ['config', '--file', join(gitDir, 'config'), '--bool', '--get', 'core.bare']);
          if (bare.status === 0 && bare.stdout === 'true') {
            const quotedGitDir = `'${gitDir.replaceAll("'", "'\\''")}'`;
            return {
              code: 'CORE_BARE',
              message: `main checkout ${root} has .git/config core.bare=true while working files are present beside .git`,
              next: `git --git-dir=${quotedGitDir} config core.bare false`,
            };
          }
        }
      } catch {
        // An unreadable nearest git directory cannot establish that this is the broken checkout.
      }
      return null;
    }
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

/**
 * The repo around `cwd`: its worktree root, the shared git dir, this worktree's git dir, and
 * whether this is the main checkout.
 *
 * The main checkout's git dir is the common dir; a linked worktree has its own under it.
 *
 * @param {string} cwd
 * @returns {{ root: string, commonDir: string, gitDir: string, isMain: boolean }}
 */
export function repoInfo(cwd) {
  const top = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    const bare = bareWorktreeFinding(cwd);
    if (bare) throw new Refused(bare.code, `${bare.message}; run ${bare.next}`);
    throw new Refused('NOT_A_REPO', 'not inside a git work tree; run git init, or cd into a repo');
  }
  const root = top.stdout;
  const commonDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDir = git(root, ['rev-parse', '--path-format=absolute', '--git-dir']);
  return { root, commonDir, gitDir, isMain: commonDir === gitDir };
}

/**
 * The full id of a commit-ish, or null when it names no commit here.
 *
 * @param {string} root
 * @param {string} ref
 * @returns {string | null}
 */
export function resolveCommit(root, ref) {
  const result = tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.status === 0 ? result.stdout : null;
}

/**
 * The commit HEAD points at, or null in a repo with no commits yet.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function headCommit(root) {
  return resolveCommit(root, 'HEAD');
}

/**
 * The tree HEAD holds, or null with no commits.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function headTree(root) {
  const result = tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
  return result.status === 0 ? result.stdout : null;
}

/**
 * True when no tracked file differs from HEAD, staged or not.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function isClean(root) {
  return git(root, ['status', '--porcelain', '--untracked-files=no']) === '';
}

/**
 * How each file under `paths` in the work tree differs from HEAD, whatever is staged: not
 * committed, changed or deleted. A file git ignores counts too, marked, since no commit holds it.
 * With no commits yet, every file there is not committed. Read-only: git takes no index lock.
 *
 * @param {string} root
 * @param {string[]} paths
 * @returns {{ path: string, how: string, ignored: boolean }[]}
 */
export function differFromHead(root, paths) {
  const listed = (args) =>
    execFileSync('git', ['--no-optional-locks', ...GIT_FLAGS, ...args], { cwd: root, encoding: 'utf8', input: '' }).split('\0').filter(Boolean);
  const base = headCommit(root) ?? listed(['hash-object', '-t', 'tree', '--stdin'])[0].trim();
  const fields = listed(['diff', '--no-renames', '--name-status', '-z', base, '--', ...paths]);
  const found = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    found.push({ path: fields[i + 1], how: { A: 'not committed', D: 'deleted' }[fields[i]] ?? 'changed', ignored: false });
  }
  for (const path of listed(['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths])) {
    found.push({ path, how: 'not committed', ignored: false });
  }
  for (const path of listed(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...paths])) {
    found.push({ path, how: 'not committed; git ignores it', ignored: true });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Files git would show as untracked: new, and not ignored.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function untracked(root) {
  const out = git(root, ['ls-files', '--others', '--exclude-standard']);
  return out ? out.split('\n') : [];
}

/**
 * True when `ancestor` is `descendant` or in its history.
 *
 * @param {string} root
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {boolean}
 */
export function contains(root, ancestor, descendant) {
  return tryGit(root, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}

/**
 * A path inside this worktree's git dir, for state that must never sit in the tree.
 *
 * @param {string} root
 * @param {string} name
 * @returns {string}
 */
export function gitPath(root, name) {
  return resolve(root, git(root, ['rev-parse', '--git-path', name]));
}

/** Refuse lane-sensitive history checks while grafts can rewrite commit ancestry despite replacement guards [L3]. */
export function refuseGrafts(root) {
  const file = gitPath(root, 'info/grafts');
  if (existsSync(file)) throw new Refused('GIT_GRAFTS', `lane checks cannot trust history while ${file} exists; ask the coordinator to remove the graft file before retrying`);
}
