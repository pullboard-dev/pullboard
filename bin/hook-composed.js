/**
 * A self-hosted pre-commit runs the CLI and its checks from the staged index with the claimed item's attached
 * companion patches applied, never from the working tree (#2593). A core item whose view half lives in a companion
 * stages a shim deletion while the importer it repoints stays unchanged here; run from the working tree, the CLI
 * itself imported the deleted shim and the hook crashed. Only node: built-ins load here, so a staged deletion can
 * never break this module.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOKS = ['pre-commit', 'pre-merge-commit'];

/** Run Git in `cwd` with the given environment; the caller decides which index Git reads. */
function git(cwd, args, env, input) {
  return spawnSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  const checkout = git(root, ['checkout-index', '--all', `--prefix=${tree}`], composed);
  if (checkout.status !== 0) return { refusal: `could not write the staged tree: ${checkout.stderr.trim()}` };
  const stagedPaths = new Set(staged.stdout.split('\0').filter(Boolean));
  const all = git(root, ['diff', '--cached', '--name-only', '-z'], composed).stdout.split('\0').filter(Boolean);
  return { index, tree, companionPaths: all.filter(path => !stagedPaths.has(path)) };
}

/**
 * Run a self-hosted pre-commit from the composed index and return its exit code, or null to run in this process:
 * another hook, a CLI that is not this checkout's own bin/pullboard.js, or a run that is already composed.
 * Checks see the composed index; paths only a companion changes are left out of the commit's own lane checks.
 * @param {string} entry this CLI's entry file
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} context
 * @returns {Promise<number | null>}
 */
export async function runComposedHook(entry, args, { cwd, env }) {
  if (args[0] !== 'hook' || !HOOKS.includes(args[1]) || env.PULLBOARD_HOOK_COMPOSED) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel'], env);
  const root = top.status === 0 ? real(top.stdout.trim()) : null;
  if (!root || real(entry) !== join(root, 'bin', 'pullboard.js')) return null;
  const path = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], env).stdout.trim();
  const indexFile = env.GIT_INDEX_FILE ? resolve(root, env.GIT_INDEX_FILE) : path;
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-hook-'));
  try {
    const composed = composeHookTree(root, { indexFile, patches: await hookCompanionPatches(root, env), env, directory });
    if ('refusal' in composed) {
      process.stderr.write(`pullboard pre-commit: blocked\n  - ${composed.refusal}\n`);
      return 1;
    }
    const run = spawnSync(process.execPath, [join(composed.tree, 'bin', 'pullboard.js'), ...args], { cwd, stdio: 'inherit',
      env: { ...env, GIT_INDEX_FILE: composed.index, PULLBOARD_HOOK_COMPOSED: '1', PULLBOARD_HOOK_COMPANION_PATHS: JSON.stringify(composed.companionPaths) } });
    return run.status ?? 1;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
