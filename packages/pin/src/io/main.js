/** Source pins: commit to tree ids, bundles keyed by tree id, and a URL seat's commits carried as one bundle [C7]. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitExecFileSync } from '../../../git/light.js';
import { gitSpawn } from '../../../git/light.js';
import { gitSpawnSync } from '../../../git/light.js';
import { repoInfo } from '../../../git/light.js';
import { tryGit } from '../../../git/light.js';
import { addWorktree } from '../../../git/index.js';
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

/*
 * Commit transport for a seat joined by board.url: its submit carries the clone's commits as one size-capped git
 * bundle, bound to the item, seat and head by a digest; the board host checks it against the claim, indexes its pack
 * into a hidden ref and checks the head out in a host-owned folder, where the ordinary submit runs [P7,C7].
 * Why: such a seat shares no filesystem with the board host, so without this the host's submit sees only main and
 * refuses EMPTY_SUBMIT. Bytes stay in memory on both sides; only git writes, into its own object store.
 */

/** Budget: the largest bundle one move carries, so its base64 fits the API's 100 kB move body; larger work waits for a chunked slice. */
export const MAX_COMMIT_BUNDLE_BYTES = 64 * 1024;

/** The moves that may carry commits. */
const CARRIERS = new Set(['submit', 'done']);

/**
 * The digest binding a bundle to one item, one seat and one head: sha256 over "item agent head" and the bundle bytes.
 * @param {{ item: number, agent: string, head: string }} binding
 * @param {Buffer} bytes
 * @returns {string}
 */
export function commitBundleDigest({ item, agent, head }, bytes) {
  return createHash('sha256').update(`${item} ${agent} ${head}\n`).update(bytes).digest('hex');
}

/** One bounded git call whose stdout stays bytes. */
function gitBytes(cwd, args, input) {
  return gitSpawnSync(args, { cwd, encoding: 'buffer', maxBuffer: 4 * MAX_COMMIT_BUNDLE_BYTES, ...(input ? { input } : {}) });
}

/**
 * The clone's commits for one submit, as {head, bundle, digest}: a git bundle of HEAD past the host main this clone
 * last fetched (origin/HEAD, else the upstream), so only the item's commits travel.
 * @param {string} cwd the clone
 * @param {{ item: number, agent: string }} binding
 * @returns {{ head: string, bundle: string, digest: string }}
 */
export function bundleCommits(cwd, { item, agent }) {
  const head = tryGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout;
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Refused('NO_COMMIT', 'nothing committed yet; commit the item work in this clone, then submit');
  const upstream = ['refs/remotes/origin/HEAD', '@{upstream}'].map((ref) => tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).stdout).find(Boolean);
  const base = upstream ? tryGit(cwd, ['merge-base', head, upstream]).stdout : '';
  if (base === head) throw new Refused('EMPTY_SUBMIT', `this clone's HEAD is the host main it fetched; commit the work for #${item}, then submit`);
  const made = gitBytes(cwd, ['bundle', 'create', '--quiet', '-', 'HEAD', ...(base ? [`^${base}`] : [])]);
  if (made.status !== 0) throw new Refused('COMMITS_REFUSED', `git could not bundle this clone's commits (${String(made.stderr).split('\n')[0]}); commit the work and submit again`);
  const bytes = made.stdout;
  if (bytes.length > MAX_COMMIT_BUNDLE_BYTES) throw new Refused('COMMITS_TOO_LARGE', `the commit bundle is ${bytes.length} bytes, over the ${MAX_COMMIT_BUNDLE_BYTES}-byte limit; fetch and merge the host's main so only the item's commits travel, or split the item`);
  return { head, bundle: bytes.toString('base64'), digest: commitBundleDigest({ item, agent, head }, bytes) };
}

/**
 * Split a v2 or v3 bundle into its prerequisites, its refs and its pack, or refuse one that is not a bundle.
 * @param {Buffer} bytes
 * @returns {{ prerequisites: string[], refs: string[], pack: Buffer }}
 */
export function parseBundle(bytes) {
  const end = bytes.indexOf('\n\n');
  const lines = end < 0 ? [] : bytes.subarray(0, end).toString('utf8').split('\n');
  if (!/^# v[23] git bundle$/u.test(lines[0] ?? '')) throw new Refused('BAD_REQUEST', 'commits.bundle is not a git bundle; submit again from the clone');
  const body = lines.slice(1).filter((line) => !line.startsWith('@'));
  const prerequisites = body.filter((line) => line.startsWith('-')).map((line) => line.slice(1, 41));
  const refs = body.filter((line) => !line.startsWith('-')).map((line) => line.split(' ')[0]);
  return { prerequisites, refs, pack: bytes.subarray(end + 2) };
}

/** Open a detached host folder at one commit through the git cell's one worktree entry point; false when git refuses. */
function addedWorktree(root, folder, head) {
  try { addWorktree(root, ['--quiet', '--detach', folder, head]); return true; } catch { return false; }
}

/**
 * Check one move's carried commits against the claim, index them under refs/pullboard/remote/<agent>/item-<id>, and
 * return the host folder whose detached head is the seat's commit, for the submit to run in.
 * @param {string} root the board host's checkout
 * @param {{ verb: string, item?: number, agent?: string, commits: any }} body
 * @param {{ remoteAgent?: string }} seat the resolved seat; only a URL-joined seat sends commits
 * @param {(read: (board: any) => any) => any} readBoard opens the host's board for one read
 * @param {(board: any, id: number) => any} getItem the store's item reader
 * @returns {string}
 */
export function receiveCommits(root, body, seat, readBoard, getItem) {
  const { verb, item, agent, commits } = body;
  if (!CARRIERS.has(verb) || !seat.remoteAgent) throw new Refused('BAD_REQUEST', 'only a submit from a seat joined by board.url carries commits; remove commits from this move');
  if (!commits || typeof commits !== 'object' || Object.keys(commits).some((key) => !['head', 'bundle', 'digest'].includes(key))
    || !/^[0-9a-f]{40}$/u.test(commits.head ?? '') || typeof commits.bundle !== 'string' || !/^[0-9a-f]{64}$/u.test(commits.digest ?? '')) {
    throw new Refused('BAD_REQUEST', 'commits takes only head (a full commit id), bundle (base64) and digest (sha256 hex)');
  }
  const bytes = Buffer.from(commits.bundle, 'base64');
  if (bytes.length > MAX_COMMIT_BUNDLE_BYTES) throw new Refused('COMMITS_TOO_LARGE', `the commit bundle is ${bytes.length} bytes, over the ${MAX_COMMIT_BUNDLE_BYTES}-byte limit; merge the host's main into the clone so only the item's commits travel, or split the item`);
  if (commitBundleDigest({ item, agent, head: commits.head }, bytes) !== commits.digest) throw new Refused('COMMITS_DIGEST', 'the commit bundle does not match its digest for this item, seat and head; submit again from the clone');
  readBoard((board) => {
    const held = getItem(board, item);
    if (held?.item_status !== 'claimed' || held.item_owner !== agent) throw new Refused('NOT_YOURS', `item #${item} is not claimed by ${agent}; claim it before sending its commits`);
  });
  const { prerequisites, refs, pack } = parseBundle(bytes);
  if (refs.length !== 1 || refs[0] !== commits.head) throw new Refused('BAD_REQUEST', 'the commit bundle must carry exactly the declared head; submit again from the clone');
  const missing = prerequisites.find((id) => tryGit(root, ['cat-file', '-e', `${id}^{commit}`]).status !== 0);
  if (missing) throw new Refused('COMMITS_BASE_MISSING', `the board host lacks the bundle's base ${missing.slice(0, 12)}; fetch and merge the host's main in the clone, then submit again`);
  const indexed = gitBytes(root, ['index-pack', '--stdin', '--fix-thin', '--strict'], pack);
  if (indexed.status !== 0) throw new Refused('COMMITS_REFUSED', `the board host could not index the bundle (${String(indexed.stderr).split('\n')[0]}); submit again from the clone`);
  if (tryGit(root, ['update-ref', `refs/pullboard/remote/${agent}/item-${item}`, commits.head]).status !== 0) throw new Refused('COMMITS_REFUSED', `the board host could not record ${commits.head.slice(0, 12)}; submit again from the clone`);
  const folder = join(repoInfo(root).commonDir, 'pullboard', 'remote-items', `${agent}-item-${item}`);
  const placed = existsSync(folder)
    ? tryGit(folder, ['checkout', '--quiet', '--force', '--detach', commits.head]).status === 0 && tryGit(folder, ['clean', '-fdq']).status === 0
    : addedWorktree(root, folder, commits.head);
  if (!placed) throw new Refused('COMMITS_REFUSED', `the board host could not check out ${commits.head.slice(0, 12)} in ${folder}; remove that folder on the host and submit again`);
  return folder;
}
