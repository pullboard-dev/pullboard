/**
 * The few git facts pullboard needs: where the repo is, which worktree this is, what HEAD holds,
 * and whether the tree is clean. Every call is a plain `git` child process.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Refused } from './refused.js';

const GIT_FLAGS = ['-c', 'core.quotepath=false'];

/**
 * Run git in `cwd` and return its trimmed output, or throw when git fails.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
export function git(cwd, args) {
  return execFileSync('git', [...GIT_FLAGS, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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
