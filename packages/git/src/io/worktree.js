import { join } from 'node:path';
import {
  cleanGitEnvironment,
  git,
  tryGit,
} from "./main.js";
import { fileSystemAdapter } from '../../../fs/index.js';
const disk = fileSystemAdapter();

/** The npm lockfiles `npm ci` installs from, in the order npm itself prefers them. */
const NPM_LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'];

/**
 * Count the packages a package.json declares under dependencies and devDependencies.
 *
 * An unreadable or malformed package.json counts as none: an install would fail on it anyway.
 *
 * @param {string} root
 * @returns {number}
 */
function declaredDependencies(root) {
  const file = join(root, 'package.json');
  if (!disk.exists(file)) return 0;
  let manifest;
  try { manifest = JSON.parse(disk.readFile(file, 'utf8')); } catch { return 0; }
  if (!manifest || typeof manifest !== 'object') return 0;
  const count = (field) => (field && typeof field === 'object' && !Array.isArray(field) ? Object.keys(field).length : 0);
  return count(manifest.dependencies) + count(manifest.devDependencies);
}

/**
 * Name the npm lockfile the checkout's HEAD commit holds, or null when none is committed.
 *
 * A lockfile counts only when HEAD has it: one that sits on disk or is only staged (a hook can
 * stage one in a new worktree) is not in the commit, and `npm ci` from it would install
 * something the commit does not record.
 *
 * @param {string} root
 * @returns {string | null}
 */
function committedLockfile(root) {
  const listed = tryGit(root, ['ls-tree', '-z', '--name-only', 'HEAD', '--', ...NPM_LOCKFILES], { env: cleanGitEnvironment() });
  if (listed.status !== 0) return null;
  const tracked = new Set(listed.stdout.split('\0').filter(Boolean));
  return NPM_LOCKFILES.find((name) => tracked.has(name)) ?? null;
}

/**
 * The install step a new worktree's next steps suggest, or null when the project needs none.
 *
 * A zero-dependency project gets no step, because `npm install` there only writes a
 * package-lock.json the first submit then refuses as UNTRACKED (I1, L3). A committed lockfile
 * gets `npm ci`, which installs exactly what it records and writes nothing. Without one,
 * `npm install` is still the step, with a note that the lockfile it writes must be committed.
 *
 * @param {string} root - The new worktree's top level.
 * @returns {{ command: string, note: string } | null}
 */
export function installStep(root) {
  if (declaredDependencies(root) === 0) return null;
  const lockfile = committedLockfile(root);
  if (lockfile) return { command: 'npm ci', note: `its own install from the committed ${lockfile}, so its tests run its own code` };
  return { command: 'npm install', note: 'its own install; it writes package-lock.json, so commit that file or the first submit is refused UNTRACKED' };
}

/**
 * Create a worktree with `git worktree add`, the one entry point that makes a checkout folder [C7,#6750].
 * Why: every folder creation reaches git through here, so a second `worktree add` elsewhere fails the operation registry.
 *
 * @param {string} cwd - A checkout of the repository.
 * @param {string[]} args - What follows `worktree add`: flags, the folder, and the commit or branch.
 * @param {{ maxBuffer?: number, env?: NodeJS.ProcessEnv }} [options] - Passed to git.
 * @returns {string} Git's trimmed output.
 */
export function addWorktree(cwd, args, options) {
  return git(cwd, ['worktree', 'add', ...args], options);
}
