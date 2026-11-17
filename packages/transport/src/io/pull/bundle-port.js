/** The tree-to-tar port the board's pull adapter serves bundles from, built with async git only [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Run one git command in a repository without blocking the event loop; resolves with its exit status. */
function gitStatus(spawnGit, repo, args) {
  return new Promise(resolve => {
    const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...env } = process.env; // a hook's git variables must not redirect the archive
    const child = spawnGit(['-C', repo, ...args], { env, stdio: 'ignore' });
    child.once('error', () => resolve(1));
    child.once('close', status => resolve(status ?? 1));
  });
}

/**
 * Build the port that maps a git tree id to the path of its tar, cached by tree id in a folder.
 *
 * Why: the pull route's bundle step must hand a runner the exact tree its job runs; building the tar with async git
 * keeps the board's event loop free, and the cache means two requests for one tree return the same bytes (git
 * stamps an archive of a bare tree with the current time, so a rebuild would differ) and concurrent requests share one build.
 *
 * @param {string} repo - The trunk repository holding the trees.
 * @param {{ dir: string, spawnGit: (args: string[], options: object) => import('node:child_process').ChildProcess }} options - The folder tars are cached in, and the streaming Git launcher the caller owns (packages/git gitSpawn), so this cell launches no process itself.
 * @returns {(tree: string) => Promise<string | null>} Resolves with the tar path, or null when the tree is malformed or not in the repository.
 */
export function makeTreeBundlePort(repo, { dir, spawnGit }) {
  const flights = new Map();
  /** Build (or find) the tar for one validated tree id. */
  async function build(tree) {
    const file = join(dir, `tree-${tree}.tar`);
    if (existsSync(file)) return file;
    if (await gitStatus(spawnGit, repo, ['cat-file', '-e', `${tree}^{tree}`]) !== 0) return null;
    mkdirSync(dir, { recursive: true });
    const partial = `${file}.${process.pid}.${flights.size}.partial`;
    try {
      if (await gitStatus(spawnGit, repo, ['archive', '--format=tar', '--output', partial, tree]) !== 0) return null;
      renameSync(partial, file);
      return file;
    } finally { rmSync(partial, { force: true }); }
  }
  return async tree => {
    if (typeof tree !== 'string' || !TREE.test(tree)) return null;
    if (!flights.has(tree)) flights.set(tree, build(tree).finally(() => flights.delete(tree)));
    return flights.get(tree);
  };
}
