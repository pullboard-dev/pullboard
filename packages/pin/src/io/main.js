/** Source pins: commit to tree ids, and bundles keyed by tree id [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitExecFileSync } from '../../../git/light.js';
import { gitSpawn } from '../../../git/light.js';
import { Refused } from '../../../kernel/light.js';
import { bundleName } from '../logic/names.js';
import { isObjectId } from '../logic/names.js';

/**
 * Run git in a repository and return trimmed stdout, or refuse with the rule that failed.
 *
 * @param {string} repo - The repository path.
 * @param {string[]} args - The git arguments.
 * @param {string} code - The refusal code if git fails.
 * @returns {string} Trimmed stdout.
 */
function git(repo, args, code) {
  try {
    return gitExecFileSync(['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw new Refused(code, `git ${args[0]} failed in ${repo}: ${String(error.stderr ?? error.message).trim()}. Check the commit exists, then retry.`);
  }
}

/**
 * Resolve a commit to the id of its root tree.
 *
 * @param {string} repo - The repository path.
 * @param {string} commit - A commit id or ref.
 * @returns {string} The tree id.
 */
export function treeOf(repo, commit) {
  return git(repo, ['rev-parse', '--verify', `${commit}^{tree}`], 'PIN_COMMIT_UNKNOWN');
}

/**
 * Pin a commit: its tree id and the tooling tree that judges it.
 *
 * Why: jobs name inputs by tree id so a temp copy is only a cache. Until a landing writes a tooling pin
 * (a later item) the tooling is the commit's own tree, which keeps today's behaviour.
 *
 * @param {string} repo - The repository path.
 * @param {string} commit - A commit id or ref.
 * @param {{ tooling?: string }} [options] - An already-known tooling tree id.
 * @returns {{ tree: string, tooling: string }} The pin.
 */
export function pinFor(repo, commit, { tooling } = {}) {
  const tree = treeOf(repo, commit);
  if (tooling !== undefined && !isObjectId(tooling)) throw new Refused('PIN_TOOLING_INVALID', 'The tooling pin must be a full tree id; pass the tree of the last landing.');
  return { tree, tooling: tooling ?? tree };
}

/**
 * Write the bundle for a tree (a tar of its files) into a folder, reusing one already there.
 *
 * Why: the bundle is the rebuild source for any cache, so it is keyed by tree id alone and written atomically.
 * It is a plain tar so a runner needs neither Node nor this repository to unpack it.
 *
 * @param {string} repo - The repository holding the tree.
 * @param {string} tree - A full tree id.
 * @param {string} folder - Where bundles live.
 * @returns {{ path: string, tree: string, reused: boolean }} The bundle file and whether it already existed.
 */
export function bundleFor(repo, tree, folder) {
  if (!isObjectId(tree)) throw new Refused('PIN_TREE_INVALID', 'A bundle is keyed by a full tree id; resolve the commit with pinFor first.');
  const path = join(folder, bundleName(tree));
  if (existsSync(path)) return { path, tree, reused: true };
  mkdirSync(folder, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  try {
    git(repo, ['archive', '--format=tar', `--output=${partial}`, tree], 'PIN_BUNDLE_FAILED');
    renameSync(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
  return { path, tree, reused: false };
}

// Budget: a tree's object list and pack are held in memory; a repository tree stays far below this ceiling.
const MAX_BYTES = 512 * 1024 * 1024;

/**
 * Run git inside one repository through the git adapter and resolve with its stdout, or refuse with the rule that failed.
 *
 * Why: the process runs asynchronously, so a gate holding its lease keeps renewing it while a large tree is listed or packed.
 *
 * @param {string} repo - The repository or work tree folder; a linked work tree is fine.
 * @param {string[]} args - The git arguments.
 * @param {string} code - The refusal code if git fails.
 * @param {Buffer | string} [input] - Bytes for stdin.
 * @returns {Promise<Buffer>} Stdout.
 */
function gitIn(repo, args, code, input) {
  return new Promise((resolve, reject) => {
    const child = gitSpawn(['-C', repo, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let size = 0;
    const fail = detail => reject(new Refused(code, `git ${args[0]} failed in ${repo}: ${detail}. Check the folder is readable and holds the tree, then retry.`));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) { child.kill('SIGKILL'); fail(`output over ${MAX_BYTES} bytes`); } else out.push(chunk);
    });
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => fail(error.message));
    child.on('close', status => (status === 0 ? resolve(Buffer.concat(out)) : fail(Buffer.concat(err).toString('utf8').trim() || `status ${status}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * List every object id a tree holds, the tree itself, its subtrees and its blobs.
 *
 * @param {string} repo - The repository or work tree folder; a linked work tree is fine.
 * @param {string} tree - A full tree id.
 * @returns {Promise<string[]>} Unique object ids.
 */
export async function listTreeObjects(repo, tree) {
  if (!isObjectId(tree)) throw new Refused('TREE_SOURCE_INVALID', 'A source is named by a full tree id; resolve the commit with pinFor first.');
  const listing = (await gitIn(repo, ['rev-list', '--objects', tree], 'TREE_SOURCE_UNKNOWN_TREE')).toString('utf8');
  return [...new Set(listing.split('\n').filter(Boolean).map(line => line.split(' ')[0]))];
}

/**
 * Pack the named objects into one pack stream, ready for `git unpack-objects` on a runner.
 *
 * @param {string} repo - The repository or work tree folder.
 * @param {string[]} ids - Full object ids to pack.
 * @returns {Promise<Buffer>} The pack bytes.
 */
export function packObjects(repo, ids) {
  return gitIn(repo, ['pack-objects', '--stdout', '-q'], 'TREE_SOURCE_PACK_FAILED', `${ids.join('\n')}\n`);
}
