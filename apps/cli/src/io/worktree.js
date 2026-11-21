/** Helpers for `pullboard worktree`: locations, committed setup and the primary checkout. Split from src/cli.js, which re-exports it [C7]. */
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { cdTo } from './context.js';
import { setupFiles } from './context.js';
import { shellWord } from './context.js';
import { uncommittedSetup } from './context.js';
import { CONFIG_FILE } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { onlyNamedBoardChanged } from '../../../../packages/link/index.js';
import { differFromHead } from '../../../../packages/git/index.js';
import { headCommit } from '../../../../packages/git/index.js';
import { mainCheckout } from '../../../../packages/git/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { registeredProjectRootsSnapshot } from '../../../../packages/seats/index.js';
import { withProjectGitTimeout } from '../../../../packages/git/index.js';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Describe the active configured location for new agent worktrees. */
export function worktreeLocation(mainRoot, config) {
  return config.worktrees === 'inside'
    ? join(mainRoot, '.claude', 'worktrees', '<lane>-N')
    : join(dirname(mainRoot), `${basename(mainRoot)}-<lane>-N`);
}

/** Explain how to recover the configured location when the primary checkout cannot be proven. */
export function unavailableWorktreeLocation() {
  return 'unavailable; run pullboard resume from the main checkout to see the configured location';
}

/** Find initialized setup that is on disk but absent from the primary checkout's committed policy. */
export function uncommittedPolicySetup(info) {
  const primary = mainCheckout(info.root);
  if (!primary?.commit) return null;
  const committedConfig = tryGit(info.root, ['ls-tree', '-z', primary.commit, '--', `:(literal)${CONFIG_FILE}`]);
  if (committedConfig.status !== 0 || committedConfig.stdout) return null;

  // The primary checkout is info.root when the gate runs there. From a linked worktree, the
  // common directory's parent is the primary checkout only for a plain .git directory: with
  // git init --separate-git-dir it is unrelated, so report the original refusal instead.
  const mainRoot = info.isMain ? info.root : basename(info.commonDir) === '.git' ? resolve(info.commonDir, '..') : null;
  if (!mainRoot) return null;
  let config;
  try { config = loadConfig(mainRoot); }
  catch { return null; }
  const setup = uncommittedSetup(mainRoot, config);
  return setup?.files.includes(CONFIG_FILE) ? setup : null;
}

/**
 * Refuse a worktree whose agent would start without pullboard's files as the main checkout has
 * them: no config, rules or hooks, or older ones (I4). Name each file and how it differs, and the
 * command that commits just those (C4).
 *
 * @param {string} mainRoot
 * @param {any} config
 */
export function refuseUncommittedSetup(mainRoot, config) {
  const hasCommit = headCommit(mainRoot) !== null;
  const differ = differFromHead(mainRoot, setupFiles(mainRoot, config))
    .filter(({ path, how }) => !(path === CONFIG_FILE && how === 'changed' && onlyNamedBoardChanged(mainRoot)));
  if (hasCommit && !differ.length) return;
  const why = hasCommit
    ? `a new worktree starts from the last commit, and these differ from it here: ${differ.map(({ path, how }) => `${path} (${how})`).join(', ')}`
    : `this repo has no commit yet, and a new worktree starts from one; not committed: ${differ.map(({ path, ignored }) => (ignored ? `${path} (git ignores it)` : path)).join(', ')}`;
  const words = differ.map(({ path }) => shellWord(path)).join(' ');
  // No commit holds a file git ignores unless it is added by force.
  const force = differ.some(({ ignored }) => ignored) ? ' -f' : '';
  const subject = hasCommit ? 'chore: commit pullboard files' : 'chore: set up pullboard';
  throw new Refused('NOT_COMMITTED', `${why}. Commit them first: ${cdTo(mainRoot)} git add${force} -- ${words} && git commit -q -m "${subject}" -- ${words}`);
}

/** Resolve a usable primary checkout without trusting the Git metadata directory as a path. */
export function primaryCheckoutRoot(info) {
  if (info.isMain) return info.root;
  let commonDir;
  try { commonDir = fs.realpath(info.commonDir); }
  catch { return null; }
  // A plain clone exposes its primary checkout directly: Git's shared directory is <root>/.git.
  // Avoid listing every linked worktree on this common path, which grows with the number of seats.
  if (basename(commonDir) === '.git') {
    const root = dirname(commonDir);
    try {
      if (fs.stat(commonDir).isDirectory() && fs.realpath(join(root, '.git')) === commonDir) return root;
    } catch { /* Invalid or stale metadata keeps the Git fallback below. */ }
  }
  /** Return unique validated primary checkouts among candidate repository paths.
   *
   * @param {string[]} candidates
   * @returns {string[]}
   */
  const matches = (candidates) => {
    const roots = new Map();
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue;
      try {
        const result = withProjectGitTimeout(candidate, () => tryGit(candidate, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']));
        const fields = result.stdout.split('\n');
        if (result.status !== 0 || fields.length !== 3 || fields.some((field) => !field)) continue;
        const [root, gitDir, candidateCommonDir] = fields;
        if (!fs.exists(join(root, '.git'))
          || fs.realpath(candidateCommonDir) !== commonDir
          || fs.realpath(gitDir) !== fs.realpath(candidateCommonDir)) continue;
        roots.set(fs.realpath(root), root);
      } catch { /* A stale registry entry or Git metadata directory is not a usable checkout. */ }
    }
    return [...roots.values()];
  };
  let worktrees;
  try { worktrees = withProjectGitTimeout(info.root, () => tryGit(info.root, ['worktree', 'list', '--porcelain', '-z'])); }
  catch (error) { if (error.code !== 'BOARD_UNAVAILABLE') throw error; worktrees = { status: 1, stdout: '' }; }
  if (worktrees.status === 0) {
    // Git lists the main worktree first, so only that entry is checked: asking every linked worktree ran Git in
    // every other seat's checkout on each claim (#2427).
    const candidates = worktrees.stdout.split('\0')
      .filter((field) => field.startsWith('worktree '))
      .map((field) => field.slice('worktree '.length)).slice(0, 1);
    const found = matches(candidates);
    if (found.length === 1) return found[0];
  }
  const registered = registeredProjectRootsSnapshot();
  if (registered === null) return null;
  const found = matches(registered);
  return found.length === 1 ? found[0] : null;
}


