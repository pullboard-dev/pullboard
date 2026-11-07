/** Tree-id source: a gate names its candidate by tree id and sends only the objects the runner's store lacks [C7]. */
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Say whether a string is a full object id.
 *
 * @param {unknown} id - The candidate.
 * @returns {boolean} True for a full lowercase hex id.
 */
function isObjectId(id) {
  return typeof id === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(id);
}

/** A refusal that names its rule: an Error carrying a stable code, with the fix in the message. */
class Refused extends Error {
  /**
   * Build the refusal.
   *
   * @param {string} code - The stable refusal code.
   * @param {string} message - What failed and what to do next.
   */
  constructor(code, message) {
    super(message);
    this.name = 'Refused';
    this.code = code;
  }
}

// Budget: a tree's object list and pack are held in memory; a repository tree stays far below this ceiling.
const MAX_BYTES = 512 * 1024 * 1024;

/**
 * Run git against one git directory and return its stdout, or refuse with the rule that failed.
 *
 * @param {string} gitDir - The bare or repository git directory.
 * @param {string[]} args - The git arguments.
 * @param {string} code - The refusal code if git fails.
 * @param {Buffer | string} [input] - Bytes for stdin.
 * @returns {Buffer} Stdout.
 */
function gitIn(gitDir, args, code, input) {
  const done = spawnSync('git', ['--git-dir', gitDir, ...args], { input, maxBuffer: MAX_BYTES, stdio: ['pipe', 'pipe', 'pipe'] });
  if (done.status !== 0) throw new Refused(code, `git ${args[0]} failed in ${gitDir}: ${String(done.stderr ?? done.error?.message ?? '').trim()}. Check the folder is writable and holds the tree, then retry.`);
  return done.stdout;
}

/**
 * Open the runner's object store: a bare repository that only holds objects, created on first use.
 *
 * Why: the store outlives any one gate, so a second gate on the same base finds the first gate's objects there.
 * It is a plain git directory, so a runner needs only git to hold it, not Node or this repository.
 *
 * @param {string} gitDir - Where the store lives.
 * @returns {{ gitDir: string, missing: (ids: string[]) => string[], receive: (pack: Buffer) => void, materialise: (tree: string, destination: string) => void }}
 */
export function runnerObjectStore(gitDir) {
  if (!existsSync(gitDir)) {
    mkdirSync(gitDir, { recursive: true });
    gitIn(gitDir, ['init', '--bare', '-q'], 'TREE_SOURCE_STORE_FAILED');
  }
  return {
    gitDir,
    /**
     * Return the ids this store does not hold, in the order asked.
     *
     * @param {string[]} ids - Full object ids.
     * @returns {string[]} The ids the store lacks.
     */
    missing(ids) {
      if (!ids.length) return [];
      const lines = gitIn(gitDir, ['cat-file', '--batch-check'], 'TREE_SOURCE_STORE_FAILED', `${ids.join('\n')}\n`).toString('utf8').split('\n');
      return lines.filter(line => line.endsWith(' missing')).map(line => line.split(' ')[0]);
    },
    /**
     * Unpack a pack of objects into the store; objects already there are skipped.
     *
     * @param {Buffer} pack - The pack bytes.
     * @returns {void}
     */
    receive(pack) { gitIn(gitDir, ['unpack-objects', '-q'], 'TREE_SOURCE_STORE_FAILED', pack); },
    /**
     * Write the tree's files into a folder, reading only from this store.
     *
     * @param {string} tree - A full tree id.
     * @param {string} destination - The folder to fill.
     * @returns {void}
     */
    materialise(tree, destination) {
      if (!isObjectId(tree)) throw new Refused('TREE_SOURCE_INVALID', 'A source is named by a full tree id; resolve the commit with pinFor first.');
      mkdirSync(destination, { recursive: true });
      const tar = gitIn(gitDir, ['archive', '--format=tar', tree], 'TREE_SOURCE_MISSING');
      const done = spawnSync('tar', ['-xf', '-', '-C', destination], { input: tar, encoding: 'utf8' });
      if (done.status !== 0) throw new Refused('TREE_SOURCE_UNPACK_FAILED', `Unpacking tree ${tree} into ${destination} failed: ${String(done.stderr ?? done.error?.message ?? '').trim()}. Clear the folder and retry.`);
    },
  };
}

/**
 * Send a candidate's tree to a runner's object store, moving only the objects the store lacks.
 *
 * Why: today every gate builds a source checkout. Naming the candidate by tree id lets the runner say which of the
 * tree's objects it already holds, so a second gate on the same base sends only the changed blobs and trees, and
 * the runner materialises the folder from objects it holds itself.
 *
 * @param {{ repo: string, tree: string, store: ReturnType<typeof runnerObjectStore> }} source - The sender's git directory or work tree, the tree id, and the runner's store.
 * @returns {{ tree: string, total: number, sent: number, reused: number, bytes: number }} Counts of objects the tree holds, sent, and already held.
 */
export function sendTree({ repo, tree, store }) {
  if (!isObjectId(tree)) throw new Refused('TREE_SOURCE_INVALID', 'A source is named by a full tree id; resolve the commit with pinFor first.');
  const gitDir = existsSync(`${repo}/.git`) ? `${repo}/.git` : repo;
  const listing = gitIn(gitDir, ['rev-list', '--objects', tree], 'TREE_SOURCE_UNKNOWN_TREE').toString('utf8');
  const ids = [...new Set(listing.split('\n').filter(Boolean).map(line => line.split(' ')[0]))];
  const lacking = store.missing(ids);
  if (!lacking.length) return { tree, total: ids.length, sent: 0, reused: ids.length, bytes: 0 };
  const pack = gitIn(gitDir, ['pack-objects', '--stdout', '-q'], 'TREE_SOURCE_PACK_FAILED', `${lacking.join('\n')}\n`);
  store.receive(pack);
  return { tree, total: ids.length, sent: lacking.length, reused: ids.length - lacking.length, bytes: pack.length };
}
