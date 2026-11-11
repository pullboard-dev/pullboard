/**
 * A self-hosted pre-commit runs the CLI and its checks from the staged index with the claimed item's attached
 * companion patches applied, never from the working tree (#2593). A core item whose view half lives in a companion
 * stages a shim deletion while the importer it repoints stays unchanged here; run from the working tree, the CLI
 * itself imported the deleted shim and the hook crashed. Only node: built-ins load here, so a staged deletion can
 * never break this module.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { gitSpawnSync } from '../../../../../packages/git/light.js';

const HOOKS = ['pre-commit', 'pre-merge-commit'];

/** Paths a hook run never loads: the tests and journeys folders and their fixtures. The composed tree leaves them out (#5498). */
const UNREAD = [':(exclude,glob)**/tests/**', ':(exclude,glob)**/journeys/**'];

/** Data files the CLI reads at load even though they sit in a folder named tests (packages/verify/data/tests/guard.json). */
const DATA_IN_TESTS = ':(glob)**/data/tests/**';

/** Files that can change what the CLI does when it loads. */
const CODE = /\.(?:m?js|cjs|json)$/u;

/** Run Git in `cwd` with the given environment; the caller decides which index Git reads. */
function git(cwd, args, env, input) {
  return gitSpawnSync(args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Resolve a path through symlinks, or null when it is gone. */
function real(path) {
  try { return realpathSync(path); } catch { return null; }
}

/**
 * The active companion patches attached to the item this checkout builds: its item folder's marker names the item,
 * otherwise the one top-level claim of the seat registered at this checkout. No board, seat or claim means none.
 * @param {string} root the checkout's top level
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ key: string, patch: string }[]>}
 */
export async function hookCompanionPatches(root, env) {
  const located = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-path', 'pullboard-item.json'], env);
  if (located.status !== 0) return [];
  const [common, markerPath] = located.stdout.trim().split('\n');
  let board;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    board = new DatabaseSync(join(common, 'pullboard', 'board.sqlite'), { readOnly: true });
  } catch { return []; }
  try {
    let id = null;
    try { id = JSON.parse(readFileSync(markerPath, 'utf8')).item ?? null; } catch { id = null; }
    if (!Number.isSafeInteger(id)) {
      const claims = board.prepare(`SELECT i.item_id FROM item i JOIN agent a ON a.agent_id = i.item_owner
        WHERE a.agent_path = ? AND i.item_status = 'claimed' AND i.item_parent_id IS NULL`).all(root);
      id = claims.length === 1 ? claims[0].item_id : null;
    }
    if (!Number.isSafeInteger(id)) return [];
    const row = board.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_patches:${id}`);
    const saved = row ? JSON.parse(row.meta_value) : null;
    return saved?.version === 1 && Array.isArray(saved.patches) ? saved.patches.filter(patch => patch.active && typeof patch.patch === 'string') : [];
  } catch { return []; } finally { board.close(); }
}

/**
 * Write the staged index with each companion patch applied to a private index and tree.
 * @param {string} root
 * @param {{ indexFile: string, patches: { key: string, patch: string }[], env: NodeJS.ProcessEnv, directory: string }} options
 * @returns {{ index: string, tree: string, companionPaths: string[] } | { refusal: string }}
 */
export function composeHookTree(root, { indexFile, patches, env, directory }) {
  const index = join(directory, 'index'), tree = join(directory, 'tree') + '/';
  copyFileSync(indexFile, index);
  const composed = { ...env, GIT_INDEX_FILE: index };
  const staged = git(root, ['diff', '--cached', '--name-only', '-z'], { ...env, GIT_INDEX_FILE: indexFile });
  for (const { key, patch } of patches) {
    const applied = git(root, ['apply', '--cached', '--whitespace=nowarn', '-'], composed, patch);
    if (applied.status !== 0) return { refusal: `companion ${key} does not apply to the staged index: ${applied.stderr.trim().split('\n')[0] ?? ''}; merge main or ask its author to re-attach it against this head` };
  }
  // Only what a hook run loads is written: the temp tree skips tests and journeys, about half of the checkout (#5498).
  const listed = git(root, ['ls-files', '-z', '--cached', '--', '.', ...UNREAD], composed);
  if (listed.status !== 0) return { refusal: `could not list the staged tree: ${listed.stderr.trim()}` };
  // A data folder named tests holds files the CLI reads when it loads, so the tests exclusion must not drop it.
  const data = git(root, ['ls-files', '-z', '--cached', '--', DATA_IN_TESTS], composed);
  if (data.status !== 0) return { refusal: `could not list the staged data files: ${data.stderr.trim()}` };
  const checkout = git(root, ['checkout-index', '-z', '--stdin', `--prefix=${tree}`], composed, listed.stdout + data.stdout);
  if (checkout.status !== 0) return { refusal: `could not write the staged tree: ${checkout.stderr.trim()}` };
  const stagedPaths = new Set(staged.stdout.split('\0').filter(Boolean));
  const all = git(root, ['diff', '--cached', '--name-only', '-z'], composed).stdout.split('\0').filter(Boolean);
  return { index, tree, companionPaths: all.filter(path => !stagedPaths.has(path)) };
}

/**
 * Whether the checkout's own files already equal the staged index where the CLI loads code: no unstaged edit to a
 * code file and no staged deletion. Then, with no companion patch, the checkout is the staged tree and nothing needs
 * copying (#5498).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env the environment naming the real index
 * @returns {boolean}
 */
function checkoutMatchesIndex(root, env) {
  const edited = git(root, ['diff', '--name-only', '-z'], env);
  const deleted = git(root, ['diff', '--cached', '--name-only', '--diff-filter=D', '-z'], env);
  if (edited.status !== 0 || deleted.status !== 0) return false;
  return ![...edited.stdout.split('\0'), ...deleted.stdout.split('\0')].some(path => CODE.test(path));
}

/**
 * Run a self-hosted pre-commit from the composed index and return its exit code, or null to run in this process:
 * another hook, a CLI that is not this checkout's own apps/cli/pullboard.js, or a run that is already composed.
 * Fixers run first against the real index; checks then see that index plus the companions, and paths only a companion
 * changes are left out of the commit's own lane checks.
 * @param {string} entry this CLI's entry file
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} context
 * @returns {Promise<number | null>}
 */
export async function runComposedHook(entry, args, { cwd, env }) {
  if (args[0] !== 'hook' || !HOOKS.includes(args[1]) || env.PULLBOARD_HOOK_COMPOSED) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel'], env);
  const root = top.status === 0 ? real(top.stdout.trim()) : null;
  if (!root || real(entry) !== join(root, 'apps/cli/pullboard.js')) return null;
  const path = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], env).stdout.trim();
  const indexFile = env.GIT_INDEX_FILE ? resolve(root, env.GIT_INDEX_FILE) : path;
  const patches = await hookCompanionPatches(root, env);
  const directories = [];
  /** Compose the current real index with the companions into a fresh private index and tree. */
  const compose = () => {
    if (patches.length === 0 && checkoutMatchesIndex(root, { ...env, GIT_INDEX_FILE: indexFile })) {
      return { index: indexFile, tree: root + '/', companionPaths: [] };
    }
    const directory = mkdtempSync(join(tmpdir(), 'pullboard-hook-'));
    directories.push(directory);
    return composeHookTree(root, { indexFile, patches, env, directory });
  };
  const blocked = refusal => { process.stderr.write(`pullboard pre-commit: blocked\n  - ${refusal}\n`); return 1; };
  try {
    let composed = compose();
    if ('refusal' in composed) return blocked(composed.refusal);
    // Fixers rewrite and stage files: they run against the real index, so the checked bytes are the committed bytes.
    if (stagedFixers(root, { ...env, GIT_INDEX_FILE: indexFile })) {
      const fixed = spawnSync(process.execPath, [join(composed.tree, 'apps/cli/pullboard.js'), ...args], { cwd, stdio: 'inherit',
        env: { ...env, GIT_INDEX_FILE: indexFile, PULLBOARD_HOOK_COMPOSED: 'fix' } });
      if (fixed.status !== 0) return fixed.status ?? 1;
      composed = compose();
      if ('refusal' in composed) return blocked(composed.refusal);
    }
    const run = spawnSync(process.execPath, [join(composed.tree, 'apps/cli/pullboard.js'), ...args], { cwd, stdio: 'inherit',
      env: { ...env, GIT_INDEX_FILE: composed.index, PULLBOARD_HOOK_COMPOSED: '1', PULLBOARD_HOOK_COMPANION_PATHS: JSON.stringify(composed.companionPaths) } });
    return run.status ?? 1;
  } finally { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); }
}

/** Whether the staged pullboard.json declares fixers; none means the fixer pass is skipped. */
function stagedFixers(root, env) {
  const shown = git(root, ['show', ':pullboard.json'], env);
  try { return shown.status === 0 && Array.isArray(JSON.parse(shown.stdout).fix) && JSON.parse(shown.stdout).fix.length > 0; } catch { return false; }
}
