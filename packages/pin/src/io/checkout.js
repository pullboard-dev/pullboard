/** The runner's bare object cache and the job checkouts built from it, kept by the pin cell so drive launches no git [C7]. */
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit as git } from './main.js';
import { spawnGit as gitSpawn } from './main.js';

// Budget: 32 fetched-commit refs give a fetch recent haves; one ref file each.
const FETCHED_REFS = 32;
/** The release tags every store refresh fetches, which proofs that unpack an old release read. */
const RELEASE_TAGS = '+refs/tags/v*:refs/tags/v*';
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Open the runner's bare object cache, creating it on first use; null with git's words when it cannot. */
async function objectStore(cache) {
  const store = join(cache, 'git');
  if (!existsSync(join(store, 'HEAD'))) {
    mkdirSync(store, { recursive: true });
    const init = await git(store, ['init', '-q', '--bare']);
    if (init.status !== 0) return { store: null, reason: init.stderr };
  }
  return { store, reason: null };
}

/**
 * Make one commit present in the runner's object cache, fetching it from the trunk remote when missing.
 * Why a fetch by id first: protocol v2 serves any reachable commit, so a runner takes only what the job names; a
 * remote that refuses that falls back to fetching its branches.
 *
 * @returns {Promise<string | null>} null once the commit is present, else why it is not.
 */
async function fetchCommit(store, trunk, commit, pack = null) {
  if (!SHA.test(String(commit ?? ''))) return `the job names no commit (${commit})`;
  if ((await git(store, ['cat-file', '-e', `${commit}^{commit}`])).status === 0) return null;
  if (typeof trunk !== 'string' || !trunk) return 'the board named no trunk remote';
  // A cold store takes the trunk's shared cached pack first, so N runners on one commit cost one pack-objects (#5932);
  // the fetch below then has the commit as a have and only adds release tags.
  if (pack && (await git(store, ['for-each-ref', '--count=1', 'refs/pullboard/fetched/', 'refs/remotes/trunk/'])).stdout === '') await fromPack(store, commit, pack);
  // The fetched commit keeps a ref, so the next fetch offers it as a have and takes only new objects. A store with no
  // refs offered none, and every job pulled trunk's whole history, 200k objects and 4-5 minutes per claim (#5805).
  // Release tags ride the same fetch, so a store refresh costs no extra round trip: proofs that unpack an old release
  // (git archive v0.8.6) found no tag on a pull runner, since --no-tags fetched none.
  const byId = await git(store, ['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', '--', trunk, `+${commit}:refs/pullboard/fetched/${commit}`, RELEASE_TAGS]);
  if (byId.status !== 0) {
    const heads = await git(store, ['fetch', '-q', '--no-tags', '--', trunk, '+refs/heads/*:refs/remotes/trunk/*', RELEASE_TAGS]);
    if (heads.status !== 0) return heads.stderr || byId.stderr;
  }
  await pruneFetched(store);
  return (await git(store, ['cat-file', '-e', `${commit}^{commit}`])).status === 0 ? null : `trunk remote has no commit ${commit}`;
}

/**
 * Index the cached trunk pack for one commit into the store and keep a ref to it. Any failure leaves the store as it
 * was, and the caller's git fetch takes the commit instead.
 * @param {string} store The runner's bare object cache.
 * @param {string} commit The trunk commit.
 * @param {(commit: string) => Promise<{ file: string } | null>} pack Where the pack comes from.
 * @returns {Promise<boolean>} Whether the commit came from the pack.
 */
async function fromPack(store, commit, pack) {
  try {
    const got = await pack(commit);
    if (!got?.file) return false;
    const status = await new Promise(resolve => {
      const child = gitSpawn(['-C', store, 'index-pack', '--stdin', '-q'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => resolve(1));
      child.once('close', resolve);
      createReadStream(got.file).once('error', () => child.stdin.destroy()).pipe(child.stdin).once('error', () => {});
    });
    if (status !== 0) return false;
    return (await git(store, ['update-ref', `refs/pullboard/fetched/${commit}`, commit])).status === 0;
  } catch { return false; }
}

/**
 * Point the primary's release tags where the store's are, so a job's checkout resolves `v0.8.6` as a clone does.
 * Why a copy: the primary borrows the store's objects through alternates, but refs are never shared that way.
 *
 * @returns {Promise<boolean>}
 */
async function shareTags(store, primary) {
  const listed = await git(store, ['for-each-ref', '--format=update %(refname) %(objectname)', 'refs/tags/v*']);
  if (listed.status !== 0) return false;
  if (!listed.stdout) return true;
  return (await git(primary, ['update-ref', '--stdin'], `${listed.stdout}\n`)).status === 0;
}

/** Keep the newest fetched-commit refs only: enough haves to negotiate small fetches, without a ref per job ever run. */
async function pruneFetched(store, keep = FETCHED_REFS) {
  const listed = await git(store, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/pullboard/fetched/']);
  const old = listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).slice(keep) : [];
  for (const ref of old) await git(store, ['update-ref', '-d', ref]);
}

/**
 * Fetch one commit from the trunk remote into the runner's cache and check it out in the named folder. Every commit in
 * `also` is fetched into the same cache, so a job that reads another commit's objects (a gate archives accepted main
 * from its checkout's own objects) finds them there.
 * Why a primary: the folder is a linked worktree of a primary checkout whose main branch is the job's main, borrowing
 * the cache's objects, as an item folder is of the coordinator checkout. A worktree of the bare cache had no main
 * branch and a primary that is not a work tree, so every pulled proof refused NOT_A_REPO (#5781).
 * Why reuse: a folder left by an earlier job under the same name is reset to the commit and cleaned of every untracked
 * and ignored file instead of being rebuilt, since preparing a fresh one cost 14 s per job (#5812) [P7].
 *
 * @param {string} cache
 * @param {string} trunk
 * @param {string} commit
 * @param {string} name
 * @param {string[]} [also]
 * @param {{ main?: string | null, pack?: ((commit: string) => Promise<{ file: string } | null>) | null }} [options] - main: the
 *   commit the primary's main branch names; default none. pack: a shared trunk pack a cold store takes before fetching.
 * @returns {Promise<{ ok: true, folder: string, primary: string, reused: boolean } | { ok: false, reason: string }>}
 */
export async function checkoutCandidate(cache, trunk, commit, name, also = [], { main = null, pack = null } = {}) {
  if (!SHA.test(String(commit ?? ''))) return { ok: false, reason: `the job names no commit (${commit})` };
  if (typeof trunk !== 'string' || !trunk) return { ok: false, reason: 'the board named no trunk remote' };
  if (main !== null && !SHA.test(String(main))) return { ok: false, reason: `the job names no main commit (${main})` };
  const { store, reason } = await objectStore(cache);
  if (!store) return { ok: false, reason };
  for (const wanted of new Set([commit, ...also, ...(main ? [main] : [])])) {
    const missing = await fetchCommit(store, trunk, wanted, pack);
    if (missing) return { ok: false, reason: missing };
  }
  const folder = join(cache, 'work', name), primary = join(cache, 'main', name);
  if (await resetCheckout({ folder, primary }, commit, main)) {
    return (await shareTags(store, primary)) ? { ok: true, folder, primary, reused: true } : { ok: false, reason: 'could not copy release tags into the checkout' };
  }
  await dropCheckout(cache, { folder, primary });
  mkdirSync(primary, { recursive: true });
  for (const args of [['init', '-q'], ['symbolic-ref', 'HEAD', 'refs/heads/main'], ['config', 'gc.auto', '0']]) {
    const step = await git(primary, args);
    if (step.status !== 0) return { ok: false, reason: step.stderr };
  }
  writeFileSync(join(primary, '.git', 'objects', 'info', 'alternates'), `${join(store, 'objects')}\n`);
  if (!(await pinMain(primary, main))) return { ok: false, reason: `could not point main at ${main}` };
  if (!(await shareTags(store, primary))) return { ok: false, reason: 'could not copy release tags into the checkout' };
  const added = await git(primary, ['worktree', 'add', '-q', '--detach', folder, commit]);
  return added.status === 0 ? { ok: true, folder, primary, reused: false } : { ok: false, reason: added.stderr };
}

/**
 * Point the primary's main branch at the job's main, or leave it unborn when the job names none, and name it the
 * trunk in `pullboard.trunk` so a proof run in the folder finds its trunk whether the folder is fresh or reused.
 *
 * @returns {Promise<boolean>}
 */
async function pinMain(primary, main) {
  const pinned = main ? await git(primary, ['update-ref', 'refs/heads/main', main])
    : await git(primary, ['update-ref', '-d', 'refs/heads/main']);
  if (pinned.status !== 0) return false;
  return (await git(primary, ['config', '--local', '--replace-all', 'pullboard.trunk', 'refs/heads/main'])).status === 0;
}

/**
 * Reuse an earlier job's folder for this commit: detach it at the commit, overwrite every tracked change, and delete
 * every untracked and ignored file and nested repository, so nothing the earlier job wrote survives. False when there
 * is no earlier folder or any step fails, and the caller builds a fresh one.
 *
 * @returns {Promise<boolean>}
 */
async function resetCheckout({ folder, primary }, commit, main) {
  if (!existsSync(join(primary, '.git')) || !existsSync(join(folder, '.git'))) return false;
  if (!(await pinMain(primary, main))) return false;
  for (const args of [['checkout', '-q', '-f', '--detach', commit], ['reset', '-q', '--hard', commit], ['clean', '-q', '-ffdx']]) {
    if ((await git(folder, args)).status !== 0) return false;
  }
  const head = await git(folder, ['rev-parse', 'HEAD']);
  return head.status === 0 && head.stdout.trim() === commit;
}

/** Remove a job's checkout and its primary from the cache; a cache from before primaries also prunes the store's worktrees. */
async function dropCheckout(cache, { folder, primary }) {
  rmSync(folder, { recursive: true, force: true });
  if (primary) rmSync(primary, { recursive: true, force: true });
  await git(join(cache, 'git'), ['worktree', 'prune']);
}
