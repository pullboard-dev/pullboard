/**
 * `pullboard runner serve`: a runner that pulls jobs from a board URL over HTTPS and fetches each candidate from the
 * board's trunk remote, so it needs no inbound ssh and may sit behind NAT on any host [P7].
 *
 * Every failure to reach the board is a wait with backoff, never a red receipt: a claim, renewal or receipt that cannot
 * get through is retried, and a candidate the runner cannot fetch is released back to the queue for another runner.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { availableParallelism } from 'node:os';
import { homedir } from 'node:os';
import { hostname } from 'node:os';
import { totalmem } from 'node:os';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment } from '../../../kernel/light.js';
import { environmentAdapter } from '../../../env/index.js';
import { PROGRESS_ENV } from './progress.js';
import { keepGateProfiles } from './pull/profiles.js';
import { watchProgress } from './progress.js';
import { pathProcesses } from './leftovers.js';
import { reapLeftovers } from './leftovers.js';
import { PRUNE_INTERVAL_MS } from './prune.js';
import { pruneRunnerStores } from './prune.js';
import { pruneRunnerStoresYielding } from './prune.js';
import { claimSlotPrefix } from './prune.js';
import { pruneStaleSlots } from './prune.js';
import { storeName } from './store-names.js';
import { firstFailingCase } from './posted-case.js';
import { JOB_WORKERS_ENV } from '../logic/policy.js';

/** The file system every read and write in this file goes through, so a test can hand a fake one [C7]. */
const disk = fileSystemAdapter();

// Budget: the lease the board grants is 2 minutes; renewing every 30 s survives three lost renewals in a row.
const RENEW_MS = 30_000;
// Budget: a renewal that could not reach the board tries again every 3 s until the 2-minute lease has really ended, not at the next 30 s tick.
const RENEW_RETRY_MS = 3_000;
const LEASE_MS = 120_000;
// Budget: the first retry after a failed board call waits 1 s, doubling to at most 4 s between tries, so a runner is back within 4 s of a restarted board (#6390).
const BACKOFF = { firstMs: 1_000, maxMs: 4_000 };
// Budget: an idle runner asks for work every 2 s, one small POST to the board.
const IDLE_MS = 2_000;
// Budget: a receipt carries the last 4 KiB of output; the full output stays on the runner with its digest in the receipt.
const TAIL_BYTES = 4096;
// Budget: one job runs at most an hour unless the caller sets its own ceiling.
const CEILING_MS = 3_600_000;
// Budget: a job's leftover processes get 2 s to end on SIGTERM before SIGKILL; a test's servers close well inside that.
const REAP_MS = 2_000;
// Budget: one concurrent job per 3 cores, so a ten-core runner serves 3 jobs and leaves room for each job's own workers.
const CORES_PER_JOB = 3;
// Budget: with runners.fetchFailFast on, a claim whose trunk fetch has not ended 120 s after the claim goes back to the queue, the board's lease length; a dead trunk then costs a job two minutes, not the 22 it cost on 15 Nov (#9024).
const FETCH_FAIL_MS = 120_000;
// Budget: with runners.fetchFailFast on, a trunk fetch that failed less than 60 s ago sends the next waiting job back without its own fetch, so ten slots behind one dead ssh try it once, not ten times in a row (#9024).
const FETCH_MEMO_MS = 60_000;
// Budget: with runners.drainOnFetchFailure on, 3 trunk fetch failures in a row stop new claims, and the trunk is probed every 30 s until it answers (#9024).
const DRAIN_AFTER = 3;
const DRAIN_PROBE_MS = 30_000;
// Budget: 32 fetched-commit refs give a fetch recent haves; one ref file each.
const FETCHED_REFS = 32;
/** This runner's own Pullboard install, which a job's trusted step uses to judge a project whose main is not Pullboard's tree (#6265). */
const RUNNER_TOOLS = fileURLToPath(new URL('../../../../', import.meta.url));
/** The release tags every store refresh fetches, which proofs that unpack an old release read. */
const RELEASE_TAGS = '+refs/tags/v*:refs/tags/v*';
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
/**
 * Why a land job cannot start on this runner, or null when it can: its shardProof run was moved to the request and never came back, or has no argv or entry [C7,#9249].
 *
 * @param {Record<string, any> | undefined} payload
 * @returns {string | null}
 */
export function unrunnableLandReason(payload) {
  const proof = payload?.shardProof;
  if (!proof) return Array.isArray(payload?.requested) && payload.requested.includes('shardProof') ? 'shardProof was moved to the job request and the request did not carry it back' : null;
  if (!Array.isArray(proof.run) || !proof.run.length || !proof.run.every(word => typeof word === 'string')) return 'shardProof.run is not a non-empty argv of strings';
  return typeof proof.entry === 'string' && proof.entry ? null : 'shardProof.entry is missing';
}

// The ref a land job pins its merged commit under on the trunk remote (packages/landing's landingRef).
const LANDING_REF = /^refs\/pullboard\/landing\/[\w.-]{1,200}$/u;
/** The line a gate job prints its receipt on; apps/cli's submit writes the same prefix into the job it offers. */
export const GATE_RECEIPT = 'PULLBOARD_GATE_RECEIPT ';
// Budget: one receipt call carries a receipt inline up to this size, under the board's 64 KiB receipt size and its 100,000-byte
// API body; a larger receipt's gate goes ahead as receiptPart calls of RECEIPT_PART_CHARS characters, as many as it takes [C7,#10774].
const RECEIPT_INLINE_BYTES = 60 * 1024;
const RECEIPT_PART_CHARS = 16 * 1024;
/** The variable a job finds its kept-output folder in; apps/cli's gate entry writes each phase's full output there. */
export const RUNNER_OUTPUT_ENV = 'PULLBOARD_RUNNER_OUTPUT';
// Budget: the runner keeps the output of its newest 40 jobs, each job's own stream capped at 8 MiB, under <cache>/output.
const KEPT_JOBS = 40;
const KEPT_JOB_BYTES = 8 * 1024 ** 2;

/** A refusal by code, as the CLI reports it: what failed and what to do next. Kept local so this runner-side file stays light. */
class Refused extends Error {
  constructor(code, message) { super(message); this.name = 'Refused'; this.code = code; }
}

/** A board call that never reached a board answer: the network, a proxy or a board restart. It is a wait, not a refusal. */
class BoardUnreachable extends Error {
  constructor(cause) { super(`board unreachable: ${cause?.message ?? cause}`); this.code = 'BOARD_UNREACHABLE'; this.network = cause instanceof Error; }
}
/** Network failures in a row before the runner logs its unreachable hint; one blip stays quiet. */
const HINT_AFTER = 3;

/**
 * Split a board URL into its jobs endpoint and key. The URL is the board's API address,
 * `https://host/api/v1/boards/<board>`, optionally with the `?k=` key the board's own server prints.
 *
 * @param {string} boardUrl
 * @param {string} [key] - Overrides the URL's key.
 * @returns {{ jobs: string, key: string | null }}
 */
export function boardEndpoint(boardUrl, key) {
  let url;
  try { url = new URL(boardUrl); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !/^\/api\/v1\/boards\/[^/]+\/?$/u.test(url.pathname)) {
    throw new Refused('USAGE', 'pullboard runner serve <board-url>: the board URL is http(s)://<host>/api/v1/boards/<board>, as the board\'s API prints it');
  }
  const found = key ?? url.searchParams.get('k');
  return { jobs: `${url.origin}${url.pathname.replace(/\/$/u, '')}/jobs`, key: found || null };
}

/** The capabilities this host offers by default: its Node major and operating system. */
export function hostCapabilities() {
  const major = Number(process.versions.node.split('.')[0]);
  return [...(major >= 22 ? ['node22'] : []), `os:${process.platform}`];
}

/**
 * One POST to the board's job queue. Throws BoardUnreachable when no board answer arrived (network error, timeout or a
 * 5xx from a proxy), and the board's own refusal, by code, when it answered no.
 */
async function queueCall(endpoint, body, fetchImpl, timeoutMs = 15_000) {
  let response;
  try {
    response = await fetchImpl(endpoint.jobs, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', ...(endpoint.key ? { 'x-pullboard-key': endpoint.key } : {}) }, body: JSON.stringify(body) });
  } catch (error) { throw new BoardUnreachable(error); }
  if (response.status >= 500 || response.status === 429) throw new BoardUnreachable(`HTTP ${response.status}`);
  let document;
  try { document = await response.json(); } catch (error) { throw new BoardUnreachable(error); }
  if (response.status !== 200) {
    const refusal = document?.error ?? {};
    throw new Refused(refusal.code ?? 'BOARD_REFUSED', refusal.message ?? `the board answered HTTP ${response.status}`);
  }
  return document;
}

/**
 * The Git launches a pull serve is handed by its app: run starts one git command (input text or a stream) and fetchTrunk
 * takes trunk refs into the object cache. Why injected: apps own the git I/O and the runner's one fetch home, so the
 * drive cell imports no git [C7].
 * @typedef {{ run: (cwd: string, args: string[], input?: string | import('node:stream').Readable | null) => Promise<{ status: number, stdout: string, stderr: string }>,
 *   fetchTrunk: (store: string, trunk: string, refs: string[]) => Promise<{ status: number, stdout: string, stderr: string }> }} PullGit
 */

/** Open the runner's bare object cache, creating it on first use; null with git's words when it cannot. */
async function objectStore(git, cache) {
  const store = join(cache, 'git');
  if (!disk.exists(join(store, 'HEAD'))) {
    // Built beside the store and renamed in whole: two serves on one cache starting together both init, and one died on git's template copy (#8836).
    const building = join(cache, `.git-init-${randomBytes(4).toString('hex')}`);
    disk.mkdir(building, { recursive: true });
    const init = await git.run(building, ['init', '-q', '--bare']);
    if (init.status === 0) { try { disk.rename(building, store); } catch { /* another serve's store is already in place */ } }
    disk.rm(building, { recursive: true, force: true });
    if (init.status !== 0 && !disk.exists(join(store, 'HEAD'))) return { store: null, reason: init.stderr };
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
async function fetchCommit(git, store, trunk, commit, pack = null, ref = null) {
  if (!SHA.test(String(commit ?? ''))) return `the job names no commit (${commit})`;
  if ((await git.run(store, ['cat-file', '-e', `${commit}^{commit}`])).status === 0) return null;
  if (typeof trunk !== 'string' || !trunk) return 'the board named no trunk remote';
  // A land shard's merged commit is on no branch, only under its landing ref: take that ref, and the commit with it [C7,#7818].
  if (typeof ref === 'string' && LANDING_REF.test(ref)) {
    const viaRef = await git.fetchTrunk(store, trunk, [`+${ref}:refs/pullboard/fetched-ref`, RELEASE_TAGS]);
    if (viaRef.status === 0 && (await git.run(store, ['cat-file', '-e', `${commit}^{commit}`])).status === 0) {
      await git.run(store, ['update-ref', `refs/pullboard/fetched/${commit}`, commit]);
      await pruneFetched(git, store);
      return null;
    }
  }
  // A cold store takes the trunk's shared cached pack first, so N runners on one commit cost one pack-objects (#5932);
  // the fetch below then has the commit as a have and only adds release tags.
  if (pack && (await git.run(store, ['for-each-ref', '--count=1', 'refs/pullboard/fetched/', 'refs/remotes/trunk/'])).stdout === '') await fromPack(git, store, commit, pack);
  // The fetched commit keeps a ref, so the next fetch offers it as a have and takes only new objects. A store with no
  // refs offered none, and every job pulled trunk's whole history, 200k objects and 4-5 minutes per claim (#5805).
  // Release tags ride the same fetch, so a store refresh costs no extra round trip: proofs that unpack an old release
  // (git archive v0.8.6) found no tag on a pull runner, since --no-tags fetched none.
  const byId = await git.fetchTrunk(store, trunk, [`+${commit}:refs/pullboard/fetched/${commit}`, RELEASE_TAGS]);
  if (byId.status !== 0) {
    const heads = await git.fetchTrunk(store, trunk, ['+refs/heads/*:refs/remotes/trunk/*', RELEASE_TAGS]);
    // A serve beside this one on the cache may have fetched the commit while this fetch collided with its ref lock (#8836).
    if (heads.status !== 0 && (await git.run(store, ['cat-file', '-e', `${commit}^{commit}`])).status !== 0) return heads.stderr || byId.stderr;
  }
  await pruneFetched(git, store);
  return (await git.run(store, ['cat-file', '-e', `${commit}^{commit}`])).status === 0 ? null : `trunk remote has no commit ${commit}`;
}

/**
 * Index the cached trunk pack for one commit into the store and keep a ref to it. Any failure leaves the store as it
 * was, and the caller's git fetch takes the commit instead.
 * @param {string} store The runner's bare object cache.
 * @param {string} commit The trunk commit.
 * @param {(commit: string) => Promise<{ file: string } | null>} pack Where the pack comes from.
 * @returns {Promise<boolean>} Whether the commit came from the pack.
 */
async function fromPack(git, store, commit, pack) {
  try {
    const got = await pack(commit);
    if (!got?.file) return false;
    if ((await git.run(store, ['index-pack', '--stdin', '-q'], disk.createReadStream(got.file))).status !== 0) return false;
    return (await git.run(store, ['update-ref', `refs/pullboard/fetched/${commit}`, commit])).status === 0;
  } catch { return false; }
}

/**
 * The board's cached trunk pack for one commit, downloaded into dir; null when the board serves none.
 * Why the board: one cached pack per trunk commit is built once on the coordinator and served to every runner, where
 * a git fetch each ran its own pack-objects, 24 at once, load 190 (#5932).
 * @param {{ jobs: string, key: string | null }} endpoint The board's jobs endpoint.
 * @param {typeof fetch} fetchImpl
 * @param {string} dir Where downloaded packs are kept.
 * @returns {(commit: string) => Promise<{ file: string } | null>}
 */
export function boardTrunkPack(endpoint, fetchImpl, dir) {
  return async commit => {
    const url = `${endpoint.jobs.replace(/\/jobs$/u, '')}/trunk/${commit}.pack`;
    const response = await fetchImpl(url, { headers: endpoint.key ? { 'x-pullboard-key': endpoint.key } : {} });
    if (response?.status !== 200 || !response.body) return null;
    // Only the newest download stays: the store keeps its objects once indexed.
    disk.rm(dir, { recursive: true, force: true });
    disk.mkdir(dir, { recursive: true });
    const file = join(dir, `trunk-${commit}.pack`);
    await pipeline(Readable.fromWeb(response.body), disk.createWriteStream(file));
    return { file };
  };
}

/**
 * Point the primary's release tags where the store's are, so a job's checkout resolves `v0.8.6` as a clone does.
 * Why a copy: the primary borrows the store's objects through alternates, but refs are never shared that way.
 *
 * @returns {Promise<boolean>}
 */
async function shareTags(git, store, primary) {
  const listed = await git.run(store, ['for-each-ref', '--format=update %(refname) %(objectname)', 'refs/tags/v*']);
  if (listed.status !== 0) return false;
  if (!listed.stdout) return true;
  return (await git.run(primary, ['update-ref', '--stdin'], `${listed.stdout}\n`)).status === 0;
}

/** Keep the newest fetched-commit refs only: enough haves to negotiate small fetches, without a ref per job ever run. */
async function pruneFetched(git, store, keep = FETCHED_REFS) {
  const listed = await git.run(store, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/pullboard/fetched/']);
  const old = listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).slice(keep) : [];
  for (const ref of old) await git.run(store, ['update-ref', '-d', ref]);
}

/**
 * A turn runner that lets up to `limit` works run at once and queues the rest in order.
 * Why: with runners.fetchConcurrent on, N slots wanting N different commits fetch together instead of each waiting for every fetch before its own [#9884].
 *
 * @param {number} limit
 * @returns {(work: () => Promise<any>) => Promise<any>}
 */
export function countingTurns(limit) {
  let running = 0;
  const waiting = [];
  const next = () => { while (running < limit && waiting.length) { running += 1; waiting.shift()(); } };
  return work => new Promise((resolve, reject) => {
    waiting.push(() => { Promise.resolve().then(work).then(resolve, reject).finally(() => { running -= 1; next(); }); });
    next();
  });
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
 * @param {{ ref?: string | null, main?: string | null, pack?: ((commit: string) => Promise<{ file: string } | null>) | null, git?: PullGit | null }} [options] - main: the
 *   commit the primary's main branch names; default none. pack: a shared trunk pack a cold store takes before fetching.
 *   git: the Git launches the caller hands in, since drive launches no git of its own [C7]; ref: the landing ref a land shard's candidate sits under, fetched by name when the commit is absent [#7818].
 *   fetchTurn: runs the fetch turn when it is not the same as exclusive; with runners.fetchConcurrent on, serveRunner hands in countingTurns so fetches of different commits overlap [#9884].
 *   fetchGate: asked inside the fetch turn before each fetch; a reason it returns ends the checkout without fetching. onFetch: told each fetch's reason, or null once it worked [#9024].
 * @returns {Promise<{ ok: true, folder: string, primary: string, reused: boolean } | { ok: false, reason: string }>}
 */
export async function checkoutCandidate(cache, trunk, commit, name, also = [], { main = null, pack = null, exclusive = work => work(), fetchTurn = null, git = null, ref = null, fetchGate = null, onFetch = null } = {}) {
  if (!git) return { ok: false, reason: 'this runner was given no git launcher; pass serveRunner its git option' };
  if (!SHA.test(String(commit ?? ''))) return { ok: false, reason: `the job names no commit (${commit})` };
  if (typeof trunk !== 'string' || !trunk) return { ok: false, reason: 'the board named no trunk remote' };
  if (main !== null && !SHA.test(String(main))) return { ok: false, reason: `the job names no main commit (${main})` };
  const phases = { fetchMs: 0, checkoutMs: 0 };
  let mark = performance.now();
  /** Charge the time since the last mark to one phase. */
  const lap = phase => { const now = performance.now(); phases[phase] += Math.round(now - mark); mark = now; };
  let store = join(cache, 'git');
  if (!disk.exists(join(store, 'HEAD'))) {
    const made = await exclusive(() => objectStore(git, cache));
    if (!made.store) return { ok: false, reason: made.reason };
    store = made.store;
  }
  // Presence is a read, so every slot checks its commits at once; only a missing commit waits for the one fetch at a time.
  const wanted = [...new Set([commit, ...also, ...(main ? [main] : [])])];
  const present = await Promise.all(wanted.map(async one => SHA.test(String(one ?? '')) && (await git.run(store, ['cat-file', '-e', `${one}^{commit}`])).status === 0));
  const absent = wanted.filter((_, index) => !present[index]);
  if (absent.length) {
    const missing = await (fetchTurn ?? exclusive)(async () => {
      for (const one of absent) {
        const refused = fetchGate?.(); if (refused) return refused;
        const reason = await fetchCommit(git, store, trunk, one, pack, one === commit ? ref : null);
        onFetch?.(reason); if (reason) return reason;
      }
      return null;
    });
    if (missing) return { ok: false, reason: missing };
  }
  lap('fetchMs');
  const folder = join(cache, 'work', name), primary = join(cache, 'main', name);
  if (await resetCheckout(git, { folder, primary }, commit, main)) {
    const tagged = await shareTags(git, store, primary);
    lap('checkoutMs');
    return tagged ? { ok: true, folder, primary, reused: true, phases } : { ok: false, reason: 'could not copy release tags into the checkout' };
  }
  await dropCheckout(git, cache, { folder, primary }, exclusive);
  disk.mkdir(primary, { recursive: true });
  for (const args of [['init', '-q'], ['symbolic-ref', 'HEAD', 'refs/heads/main'], ['config', 'gc.auto', '0']]) {
    const step = await git.run(primary, args);
    if (step.status !== 0) return { ok: false, reason: step.stderr };
  }
  disk.writeFile(join(primary, '.git', 'objects', 'info', 'alternates'), `${join(store, 'objects')}\n`);
  if (!(await pinMain(git, primary, main))) return { ok: false, reason: `could not point main at ${main}` };
  if (!(await shareTags(git, store, primary))) return { ok: false, reason: 'could not copy release tags into the checkout' };
  const added = await git.run(primary, ['worktree', 'add', '-q', '--detach', folder, commit]);
  lap('checkoutMs');
  return added.status === 0 ? { ok: true, folder, primary, reused: false, phases } : { ok: false, reason: added.stderr };
}

/**
 * Point the primary's main branch at the job's main, or leave it unborn when the job names none, and name it the
 * trunk in `pullboard.trunk` so a proof run in the folder finds its trunk whether the folder is fresh or reused.
 *
 * @returns {Promise<boolean>}
 */
async function pinMain(git, primary, main) {
  const pinned = main ? await git.run(primary, ['update-ref', 'refs/heads/main', main])
    : await git.run(primary, ['update-ref', '-d', 'refs/heads/main']);
  if (pinned.status !== 0) return false;
  return (await git.run(primary, ['config', '--local', '--replace-all', 'pullboard.trunk', 'refs/heads/main'])).status === 0;
}

/**
 * Reuse an earlier job's folder for this commit: detach it at the commit, overwrite every tracked change, and delete
 * every untracked and ignored file and nested repository, so nothing the earlier job wrote survives. False when there
 * is no earlier folder or any step fails, and the caller builds a fresh one.
 *
 * @returns {Promise<boolean>}
 */
async function resetCheckout(git, { folder, primary }, commit, main) {
  if (!disk.exists(join(primary, '.git')) || !disk.exists(join(folder, '.git'))) return false;
  if (!(await pinMain(git, primary, main))) return false;
  // One forced checkout moves the index and every tracked file to the commit (it rewrites only what differs), so no
  // separate hard reset walks the tree again; the clean then removes what the last job left, and one read of each
  // proves the folder is exactly the commit's tree.
  for (const args of [['checkout', '-q', '-f', '--detach', commit], ['clean', '-q', '-ffdx']]) {
    if ((await git.run(folder, args)).status !== 0) return false;
  }
  const [head, status] = await Promise.all([git.run(folder, ['rev-parse', 'HEAD']), git.run(folder, ['status', '--porcelain=v1', '--untracked-files=all'])]);
  return head.status === 0 && head.stdout.trim() === commit && status.status === 0 && status.stdout === '';
}

/**
 * Move a job's checkout and its primary out of the cache and delete them in the background; a cache from before
 * primaries also prunes the store's worktrees.
 * Why a move: a primary carries its test-action cache, tens of thousands of files, and a synchronous delete held the
 * whole serve (every slot's lease renewal too) for the length of that walk.
 */
async function dropCheckout(git, cache, { folder, primary }, exclusive = work => work()) {
  const trash = join(cache, 'trash');
  for (const path of [folder, primary]) {
    if (!path || !disk.exists(path)) continue;
    const gone = join(trash, `${randomBytes(6).toString('hex')}`);
    try { disk.mkdir(trash, { recursive: true }); disk.rename(path, gone); disk.promises.rm(gone, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
    catch { disk.rm(path, { recursive: true, force: true }); }
  }
  await exclusive(() => git.run(join(cache, 'git'), ['worktree', 'prune']));
}

/** What a runner operator may hand every job beyond the runner-owned values: progress reporting and fixture markers. */
const PASSED_ENV = /^(?:PULLBOARD_TEST_PROGRESS|PULLBOARD_CHROME|PLAYWRIGHT_BROWSERS_PATH|(?:PULLBOARD_)?FIXTURE_[A-Z0-9_]+)$/u;

/** The only names a job request may set for its job: test-only fixture switches, never PATH, HOME or a loader option [C7,#10848]. */
export const JOB_ENV_NAME = /^(?:PULLBOARD_)?FIXTURE_[A-Z0-9_]+$/u;
// Budget: a fixture switch is a short flag; a longer value is a payload, which belongs in the request's input.
const JOB_ENV_VALUE_CHARS = 1024;

/**
 * The variables a job request's env map sets, checked: every name a fixture switch, every value a short string.
 * Why: a variable set in the seat's shell around pullboard test never reached the runner job, so hooks-on proofs took
 * throwaway probe commits (#10842); the request carries it instead, and nothing outside the fixture names rides along.
 *
 * @param {unknown} requested - The request's env map; absent or null sets nothing.
 * @returns {Record<string, string>}
 */
export function requestedJobEnvironment(requested) {
  if (requested === undefined || requested === null) return {};
  if (typeof requested !== 'object' || Array.isArray(requested)) throw new Refused('JOB_ENV_REFUSED', 'a job request\'s env is a map of variable names to strings; next: offer the job again with a map');
  for (const [key, value] of Object.entries(requested)) {
    if (!JOB_ENV_NAME.test(key)) throw new Refused('JOB_ENV_REFUSED', `a job request may set only PULLBOARD_FIXTURE_* or FIXTURE_* variables, not ${key.slice(0, 80)}; next: drop it from the request`);
    if (typeof value !== 'string' || value.length > JOB_ENV_VALUE_CHARS || value.includes('\0')) throw new Refused('JOB_ENV_REFUSED', `${key} in a job request is not a string of at most ${JOB_ENV_VALUE_CHARS} characters; next: shorten it`);
  }
  return { ...requested };
}

/**
 * A pulled job's own environment and the folders it lives in: a per-job HOME and temp folder beside the checkout, and
 * PULLBOARD_RUNNER_JOB, as a pushed runner builds it, plus the runner's shared cache folder and a machine home inside the job's HOME.
 * Why: a job that inherited the runner service's environment ran with the host's real HOME, ~/.pullboard and shared temp
 * folder, and its proof failed where the controller's passed; one with no machine home read the account's real runner pools.
 *
 * @param {string} cache
 * @param {string} name - The job's checkout name.
 * @param {string} job - The job id, carried as PULLBOARD_RUNNER_JOB.
 * @param {NodeJS.ProcessEnv} [host] - The runner service's environment, read for PATH and the passed names only.
 * @param {unknown} [requested] - The job request's env map: fixture switches the job's own caller set, over the host's [#10848].
 * @returns {{ env: Record<string, string>, folder: string, temporary: string }}
 */
export function jobEnvironment(cache, name, job, host = environmentAdapter().all(), requested = null) {
  const asked = requestedJobEnvironment(requested);
  // A host that names an existing folder in PULLBOARD_RUNNER_TMP_ROOT, such as a RAM disk, keeps the job's TMPDIR there instead of under the cache, so test temp churn stays off the disk's file-event log. Read from host only, never passed on.
  const root = host.PULLBOARD_RUNNER_TMP_ROOT, onNamed = typeof root === 'string' && root !== '' && disk.exists(root) && disk.stat(root).isDirectory();
  const folder = join(cache, 'env', name), home = join(folder, 'home'), temporary = onNamed ? join(root, name) : join(folder, 'tmp');
  try { disk.rm(folder, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a stale folder a writer still fills is the prune's; its home and tmp are made below */ }
  if (onNamed) { try { disk.rm(temporary, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the job starts in whatever is left */ } }
  // One cache per runner that every job's keyed caches outlive the job in; a job's own HOME and TMPDIR start empty (#8233).
  const shared = join(cache, 'shared-cache');
  for (const path of [home, temporary, shared]) disk.mkdir(path, { recursive: true, mode: 0o700 });
  const safePath = [dirname(process.execPath), host.PATH || '/usr/local/bin:/usr/bin:/bin'].join(delimiter);
  const passed = Object.fromEntries(Object.entries(host).filter(([key, value]) => PASSED_ENV.test(key) && typeof value === 'string'));
  // The job's own machine pool: without it the job's run read the OS account's ~/.pullboard, and on the board host a
  // pulled gate shard saw the real runners there and fanned out onto them, holding their pools for 37 min (#8361).
  const machine = join(home, '.pullboard');
  // A job's HOME is empty, so Playwright would look for browsers in an empty cache; with no host PLAYWRIGHT_BROWSERS_PATH, point it at the host's default browser cache folder when that exists.
  const hostHome = typeof host.HOME === 'string' && host.HOME !== '' ? host.HOME : homedir();
  const browsers = ['Library/Caches/ms-playwright', '.cache/ms-playwright'].map(path => join(hostHome, path)).find(path => disk.exists(path) && disk.stat(path).isDirectory());
  if (passed.PLAYWRIGHT_BROWSERS_PATH === undefined && browsers) passed.PLAYWRIGHT_BROWSERS_PATH = browsers;
  return { env: { ...passed, ...asked, ...childEnvironment({ safePath, workerId: job }, home, temporary, machine), PULLBOARD_RUNNER_SHARED_CACHE: shared }, folder, temporary };
}

/**
 * The folder a job's full output is kept in on this runner, by job id and attempt, so a red receipt's cause stays
 * readable after its checkout is deleted. Why on the runner: a receipt is capped at 64 KiB, and a proof's output is not.
 *
 * @param {string} cache
 * @param {string} job
 * @param {number} attempt
 * @returns {string}
 */
export function keptOutputFolder(cache, job, attempt) {
  return join(cache, 'output', `${String(job).replace(/[^A-Za-z0-9._-]/gu, '-')}-${attempt}`);
}

/** Make a job's kept-output folder and drop all but the newest KEPT_JOBS; null when the disk refuses, which keeps nothing. */
function keepFolder(cache, job, attempt) {
  const folder = keptOutputFolder(cache, job, attempt), parent = join(cache, 'output');
  try {
    disk.rm(folder, { recursive: true, force: true });
    disk.mkdir(folder, { recursive: true, mode: 0o700 });
    const old = disk.list(parent).map(name => ({ name, at: disk.stat(join(parent, name)).mtimeMs })).sort((a, b) => b.at - a.at).slice(KEPT_JOBS);
    for (const { name } of old) disk.rm(join(parent, name), { recursive: true, force: true });
    return folder;
  } catch { return null; }
}

/**
 * The queue calls that post one receipt: the receipt itself when it fits one call, else its gate's JSON text as
 * receiptPart calls, then the receipt naming them by count, bytes and sha256, which the board joins [C7,#10771,#10774].
 * Why: a sharded gate's receipt names its proof files in full; past 60 KiB it was dropped and read as a gate that printed no receipt.
 *
 * @param {Record<string, any>} receipt
 * @returns {Record<string, any>[]}
 */
function receiptCalls(receipt) {
  const gate = receipt?.gate;
  if (!gate || typeof gate !== 'object' || Buffer.byteLength(JSON.stringify(receipt)) <= RECEIPT_INLINE_BYTES) return [{ action: 'receipt', receipt }];
  const text = JSON.stringify(gate), parts = [];
  for (let at = 0; at < text.length; at += RECEIPT_PART_CHARS) parts.push(text.slice(at, at + RECEIPT_PART_CHARS));
  const envelope = { ...receipt, gateParts: { count: parts.length, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') } };
  delete envelope.gate;
  return [...parts.map((part, index) => ({ action: 'receiptPart', part: { index, count: parts.length, text: part } })), { action: 'receipt', receipt: envelope }];
}

/**
 * Post one receipt through `call` under the held claim, in parts when it is over one call. A board that takes no receipt
 * parts (JOB_ACTION) gets a red receipt naming the receipt's size instead, so the gate still ends and says why [C7,#10774].
 *
 * @param {(body: Record<string, unknown>) => Promise<any>} call
 * @param {{ job: string, runner: string, token: string }} held
 * @param {Record<string, any>} receipt
 * @returns {Promise<any>} The board's answer to the receipt call.
 */
async function postReceiptCalls(call, held, receipt) {
  const calls = receiptCalls(receipt), last = calls[calls.length - 1];
  try { for (const body of calls.slice(0, -1)) await call({ ...body, ...held }); }
  catch (error) {
    if (error?.code !== 'JOB_ACTION') throw error;
    const why = `the gate receipt is ${last.receipt.gateParts.bytes} bytes, more than one queue call carries, and this board takes no receiptPart calls; update the board, then submit again`;
    return call({ action: 'receipt', ...held, receipt: { ...receipt, gate: { version: 1, green: false, error: why } } });
  }
  return call({ ...last, ...held });
}

/**
 * Run a job's argv in its checkout, in its own process group so a lost lease or the ceiling stops all of it. `input`,
 * when given, is written to its stdin. The last stdout line starting with `receiptLine` is kept whole at any length,
 * apart from the output tail; any other line is dropped as soon as its start shows it is not a receipt [#10774].
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @param {{ ceilingMs?: number, env?: NodeJS.ProcessEnv, input?: string | null, receiptLine?: string | null, keep?: string | null }} [options] - keep:
 *   a file the stream's first 8 MiB is copied to.
 * @returns {{ done: Promise<{ status: number | null, signal: string | null, outputSha256: string, outputBytes: number, tail: string, line: string | null }>, stop: () => void }}
 */
export function runJob(argv, cwd, { ceilingMs = CEILING_MS, env = environmentAdapter().all(), input = null, receiptLine = null, keep = null } = {}) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const digest = createHash('sha256');
  let bytes = 0, tail = Buffer.alloc(0), partial = Buffer.alloc(0), skip = false, line = null;
  const prefix = receiptLine === null ? null : Buffer.from(receiptLine);
  const opens = row => row.length >= prefix.length && row.subarray(0, prefix.length).equals(prefix);
  const take = chunk => {
    // The kept copy is the stream's first KEPT_JOB_BYTES; the receipt's tail carries its end.
    if (keep && bytes < KEPT_JOB_BYTES) { try { disk.appendFile(keep, chunk.subarray(0, KEPT_JOB_BYTES - bytes), { mode: 0o600 }); } catch { keep = null; } }
    digest.update(chunk); bytes += chunk.length;
    tail = Buffer.concat([tail, chunk]); if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
  };
  /** Keep the newest whole stdout line that starts with the receipt prefix, by bytes so a character split across chunks survives. */
  const scan = chunk => {
    if (prefix === null) return;
    let rest = partial.length ? Buffer.concat([partial, chunk]) : chunk, at;
    partial = Buffer.alloc(0);
    while ((at = rest.indexOf(10)) !== -1) {
      const row = rest.subarray(0, at); rest = rest.subarray(at + 1);
      if (skip) { skip = false; continue; }
      if (opens(row)) line = row.toString('utf8');
    }
    if (skip) return;
    if (rest.length >= prefix.length && !opens(rest)) { skip = true; return; }
    partial = Buffer.from(rest);
  };
  child.stdout.on('data', chunk => { take(chunk); scan(chunk); }); child.stderr.on('data', take);
  if (input !== null) { child.stdin.on('error', () => { /* a job that exits before reading its input is judged by its exit */ }); child.stdin.end(input); }
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  const ceiling = setTimeout(stop, ceilingMs);
  const done = new Promise(resolve => {
    child.on('error', error => { take(Buffer.from(String(error.message))); });
    child.on('close', (status, signal) => {
      clearTimeout(ceiling);
      if (prefix !== null && !skip && opens(partial)) line = partial.toString('utf8');
      resolve({ status, signal, outputSha256: digest.digest('hex'), outputBytes: bytes, tail: tail.toString('utf8'), line });
    });
  });
  return { done, stop, pid: child.pid };
}

/**
 * How many jobs one serve runs at once: the setting when given, else one per 3 cores, at least one.
 * Why: one job per serve left nine of a ten-core runner's cores idle while gates queued (#5805).
 *
 * @param {number | string | undefined | null} [setting] - The --jobs flag or PULLBOARD_RUNNER_JOBS.
 * @param {number} [cores]
 * @returns {number}
 */
export function serveSlots(setting, cores = availableParallelism()) {
  if (setting === undefined || setting === null || setting === '') return Math.max(1, Math.floor(cores / CORES_PER_JOB));
  const slots = Number(setting);
  if (!Number.isInteger(slots) || slots < 1) throw new Refused('USAGE', `runner serve --jobs takes a whole number of at least 1, not ${setting}`);
  return slots;
}

/**
 * How many test workers a job of a serve may use: twice its even share of the runner's cores, at least 2, never more than its file count.
 * Why twice: tests mostly wait on spawned processes, git and timers, so an even share left a 10-core runner at 47% CPU while
 * 4-file jobs ran their files one after another for 640-1055 s (#5919 kept jobs from starving each other; this keeps that and fills idle cores).
 *
 * @param {number} slots - How many jobs the serve runs at once.
 * @param {number} [cores]
 * @param {number | null} [files] - How many test files the job runs, when known.
 * @param {number} [factor] - The multiple of the even share a job may use; default 2.
 * @returns {number}
 */
export function jobWorkers(slots, cores = availableParallelism(), files = null, factor = 2) {
  const share = Math.max(2, Math.ceil(factor * cores / Math.max(1, slots)));
  return Math.max(1, Number.isInteger(files) && files > 0 ? Math.min(files, share) : share);
}

/** The variable naming one claim of a job, beside PULLBOARD_RUNNER_JOB, so a sweep spares a same-named job of another serve. */
export const RUNNER_CLAIM_ENV = 'PULLBOARD_RUNNER_CLAIM';

/**
 * The pids of live processes whose environment carries PULLBOARD_RUNNER_JOB=<job> and, when they carry a claim at all,
 * this claim; this process excluded.
 * Why the environment: a job's child that starts its own session leaves the job's process group, but keeps the marker.
 * Why the claim: fixture jobs share ids, and two serves on one runner may run two of them at once.
 * macOS hides the environment of its own platform binaries (sh, sleep); those end with the job's process group.
 *
 * @param {string} job
 * @param {string | null} [claim] - The claim's PULLBOARD_RUNNER_CLAIM value.
 * @returns {Promise<number[]>}
 */
export async function jobProcesses(job, claim = null) {
  const marker = `PULLBOARD_RUNNER_JOB=${job}`, prefix = `${RUNNER_CLAIM_ENV}=`;
  const ours = words => words.includes(marker) && (claim === null || !words.some(word => word.startsWith(prefix)) || words.includes(prefix + claim));
  if (process.platform === 'linux') {
    const pids = [];
    for (const entry of disk.list('/proc')) {
      if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
      try { if (ours(disk.readFile(`/proc/${entry}/environ`, 'utf8').split('\0'))) pids.push(Number(entry)); } catch { /* gone or not ours */ }
    }
    return pids;
  }
  const listed = await new Promise(resolve => {
    execFile('ps', ['-ax', '-ww', '-E', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout)));
  });
  return listed.split('\n').flatMap(row => {
    const found = /^\s*(\d+)\s(.*)$/u.exec(row);
    if (!found || Number(found[1]) === process.pid) return [];
    return ours(found[2].split(/\s+/u)) ? [Number(found[1])] : [];
  });
}

/**
 * End every process a job started: its process group, then any process still carrying its marker, SIGTERM first and
 * SIGKILL for what outlives the grace. Returns the marked pids that were still running when the sweep began.
 *
 * @param {string} job
 * @param {number | undefined} group - The job's process group (its first process's pid).
 * @param {{ claim?: string | null, folder?: string | string[] | null, graceMs?: number, list?: (job: string, claim: string | null) => Promise<number[]>, pause?: (ms: number) => Promise<void> }} [options] - folder: the job's
 *   environment folder, or it and its work tree; a process whose command line names a path in one is the job's too, which is how Chrome and orphaned test processes are found (#7811, #7813); so is one whose environment names it, a fixture's local runner or view (#7819).
 * @returns {Promise<number[]>}
 */
export async function reapJob(job, group, { claim = null, folder = null, graceMs = REAP_MS, list: listMarked = jobProcesses, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const list = async () => [...new Set([...await listMarked(job, claim), ...(folder ? await pathProcesses(folder, { environment: true }) : [])])];
  const kill = (pid, name) => { try { process.kill(pid, name); } catch { /* already gone */ } };
  if (group) kill(-group, 'SIGTERM');
  const found = await list();
  let left = found;
  for (const pid of left) kill(pid, 'SIGTERM');
  for (const until = Date.now() + graceMs; left.length && Date.now() < until;) { await pause(100); left = await list(); }
  if (group) kill(-group, 'SIGKILL');
  for (const pid of left) kill(pid, 'SIGKILL');
  for (let tries = 0; left.length && tries < 20; tries += 1) { await pause(50); left = await list(); }
  return found;
}

/**
 * The receipt a gate job posts: the gate's own PULLBOARD_GATE_RECEIPT line, parsed, beside the run's exit and output
 * digest. A gate that printed no such line is red with what its output ended on, never a green guess.
 */
function gateReceipt(result, commit, durationMs) {
  let gate = null;
  try { gate = result.line ? JSON.parse(result.line.slice(GATE_RECEIPT.length)) : null; } catch { gate = null; }
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    gate = { version: 1, green: false, error: `the gate job printed no ${GATE_RECEIPT.trim()} line (exit ${result.status ?? result.signal}): ${result.tail.slice(-2000)}` };
  }
  return { status: result.status, signal: result.signal, commit, outputSha256: result.outputSha256, outputBytes: result.outputBytes, durationMs, gate };
}

/**
 * Whether a machine under this load takes another job: its one-minute load is under `share` of its cores [P7].
 * Why: with no runners the machine runs its own gates, and a job taken at any load thrashed a busy Mac; the row waits in the queue instead.
 * A runner with no job running still takes one at any load, so a person on one busy machine always gets their gate [P7].
 *
 * A machine already holding a check-baseline job takes no second one at any share: it claims with that kind excepted,
 * and other kinds keep this load-share admission [C7,#10794]. Why: on a board with no runners every add and edit queues
 * a baseline for the one local runner, and a burst of them must never load the board machine (#10787).
 *
 * @param {{ load: number, cores: number, share: number, running?: number, held?: string[] }} machine - running: jobs this
 *   runner holds now, default 1; held: the job kinds the machine's runner holds now, across every board it serves.
 * @returns {boolean | { except: string[] }} false to wait; otherwise true, or the kinds the claim must skip.
 */
export function localLoadAdmits({ load, cores, share, running = 1, held = [] }) {
  if (!(running === 0 || load < share * cores)) return false;
  const except = ONE_AT_A_TIME_KINDS.filter(kind => held.includes(kind));
  return except.length ? { except } : true;
}

/** Job kinds a machine's runner holds one of at a time: the check baseline, offered on every add and edit [C7,#10794]. */
const ONE_AT_A_TIME_KINDS = ['check-baseline'];

/**
 * The job kinds one machine's runner holds across all the boards it serves, and one claim at a time among them, so two
 * boards' serves never both claim a check baseline between admission and claim [C7,#10794]. The local runner shares
 * one ledger across its boards; any other serve keeps its own.
 *
 * @returns {{ list: () => string[], add: (kind: string) => void, drop: (kind: string) => void, claiming: <T>(work: () => Promise<T>) => Promise<T> }}
 */
export function heldKinds() {
  const counts = new Map();
  let turn = Promise.resolve();
  return {
    list: () => [...counts.keys()],
    add: kind => { counts.set(kind, (counts.get(kind) ?? 0) + 1); },
    drop: kind => { const left = (counts.get(kind) ?? 1) - 1; if (left > 0) counts.set(kind, left); else counts.delete(kind); },
    claiming: work => { const next = turn.then(work, work); turn = next.catch(() => {}); return next; },
  };
}

/** The board refusals that end one job, never the serve: the job is released and its slot claims again [C7]. */
const PER_JOB_REFUSALS = new Set(['JOB_RECEIPT', 'JOB_WRITE_TIMEOUT', 'HOP_FENCED', 'BOARD_BUSY', 'HOP_HELD']);

/**
 * Serve jobs from one board until the signal aborts, or after one job with `once`.
 * Why `once` never waits: a sandboxed runner starts, takes at most one job, and is thrown away, so an empty queue ends it.
 *
 * @param {object} options
 * @param {string} options.board - The board's API URL.
 * @param {string} [options.key] - The board key, when the URL carries none.
 * @param {string} [options.runner] - This runner's id; default the host name plus a random suffix; its slot folders are named by host alone, so they outlive a restart.
 * @param {string[]} [options.capabilities] - What this runner can run; default hostCapabilities().
 * @param {string} [options.cache] - Where fetched history and checkouts live; default ~/.pullboard-runner/pull.
 * @param {boolean} [options.once] - Return after one job (posted or released), or at once when the queue is empty.
 * @param {number | string} [options.jobs] - How many jobs run at once; default PULLBOARD_RUNNER_JOBS, else serveSlots().
 * @param {number} [options.cores] - This runner's cores, shared out between its jobs; default availableParallelism().
 * @param {AbortSignal} [options.signal]
 * @param {(state: { running: number, held: string[] }) => boolean | { except: string[] }} [options.admit] - Asked before each claim, with the jobs it holds now and the kinds `held` lists; false leaves the queue untouched and tries again after the idle wait; `except` names kinds the claim skips (localLoadAdmits).
 * @param {ReturnType<typeof heldKinds>} [options.ledger] - The machine's ledger of held job kinds, shared by the local runner's serves of every board; default one of this serve's own.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waits for idle and backoff; the default also ends when the signal aborts.
 * @param {(line: string) => void} [options.say]
 * @param {string} [options.unreachableHint] - Logged once a streak of network failures reaches HINT_AFTER: the likely
 *   cause on this host and its fix, so an installed service never retries silently.
 * @param {{ renewMs?: number, renewRetryMs?: number, leaseMs?: number, idleMs?: number, firstMs?: number, maxMs?: number, ceilingMs?: number, reapMs?: number, progressMs?: number }} [options.timing] - progressMs: how often a run's test progress is posted.
 * @param {Record<string, (claim: object, tools: { cache: string, renew: () => Promise<boolean>, env: Record<string, string> }) => Promise<object>>} [options.handlers] - Jobs
 *   of these kinds run in this process instead of as an argv: a landing merges and pushes trunk itself. The handler's
 *   result is the receipt; renew extends the lease and reads false once another runner holds the job. Its cache is the
 *   slot's own folder, the serve's cache for slot 0.
 * @param {{ nap: (ms: number) => Promise<void> }} [options.wake] - runners.localWake: an idle wait that also ends when an offering command signals a new job (watchWake); without it the idle wait is the full idleMs [#10409].
 * @param {(commit: string) => Promise<{ file: string } | null>} [options.trunkPack] - Where a cold cache takes a shared
 *   trunk pack; default the board's, boardTrunkPack.
 * @param {{ session: 'gui' | 'daemon', guiRunning: () => Promise<boolean> | boolean }} [options.peer] - With it, a serve that is not the GUI-session copy claims nothing while guiRunning reports another serve of its install in a GUI session, and claims again once it reports none; the GUI copy and a serve given no peer claim as today (#10840).
 * @param {{ changed: (commit: string) => Promise<boolean>, refresh: (commit: string) => Promise<unknown> }} [options.runnerCode] - With it, a claim answer's runnerCommit that differs from the installed code stops claiming; held jobs finish and post, the code is rebuilt from that commit, and the serve returns restart naming it (#10800).
 * @param {PullGit} [options.git] - The Git launches checkouts use; without it every claimed job is released.
 * @param {number} [options.jobWorkerFactor] - The multiple of its even share of cores a job runs test files at once; default 2.
 * @param {boolean} [options.pulledProfilePaths] - gate.pulledProfilePaths: copy each gate phase's timing profile into the job's kept folder and name it on the phase row as profileKept; default off.
 * @param {(folder: string) => void} [options.removeFolder] - Removes a finished job's environment folder; a failure is said and left to the prune, never a stopped serve.
 * @returns {Promise<{ jobs: Array<{ job: string, outcome: 'posted' | 'released' | 'lost', receipt?: object }>, waits: number[], slots: number }>}
 */
export async function serveRunner({ board, key, runner, capabilities = hostCapabilities(), cache = join(homedir(), '.pullboard-runner', 'pull'),
  once = false, jobs: jobsSetting = environmentAdapter().get('PULLBOARD_RUNNER_JOBS'), cores = availableParallelism(), signal, admit = () => true, ledger = heldKinds(), runnerCode = null, peer = null, fetchImpl = fetch, sleep = null, say = () => {}, timing = {}, handlers = {}, trunkPack, unreachableHint, git, fetchFailFast = false, wake = null, drainOnFetchFailure = false, handBackUnrunnable = false, fetchConcurrent = false, postedLineNamesCase = false, pulledProfilePaths = false, jobWorkerFactor = 2, pruneYields = false, prune: pruneStores = pruneRunnerStores, pruneYielding = pruneRunnerStoresYielding, removeFolder = folder => disk.rm(folder, { recursive: true, force: true, maxRetries: 3 }) }) {
  const endpoint = boardEndpoint(board, key);
  const pack = trunkPack ?? boardTrunkPack(endpoint, fetchImpl, join(cache, 'packs'));
  const host = hostname().replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40) || 'runner';
  const id = runner ?? `${host}-${randomBytes(3).toString('hex')}`;
  const { renewMs = RENEW_MS, renewRetryMs = RENEW_RETRY_MS, leaseMs = LEASE_MS, idleMs = IDLE_MS, firstMs = BACKOFF.firstMs, maxMs = BACKOFF.maxMs, ceilingMs = CEILING_MS, reapMs = REAP_MS, fetchFailMs = FETCH_FAIL_MS, fetchMemoMs = FETCH_MEMO_MS, drainProbeMs = DRAIN_PROBE_MS, pruneMs = PRUNE_INTERVAL_MS } = timing;
  const slots = once ? 1 : serveSlots(jobsSetting, cores);
  // Every wait ends the moment the signal aborts, so an idle runner stops at once and its timer leaves nothing alive [C7,#8250].
  const stopped = signal ? new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }) : null;
  const nap = ms => {
    // An injected sleep is the caller's clock; the default one clears its own timer when the signal aborts first.
    if (sleep) return stopped ? Promise.race([sleep(ms), stopped]) : sleep(ms);
    let timer;
    const own = new Promise(resolve => { timer = setTimeout(resolve, ms); });
    return (stopped ? Promise.race([own, stopped]) : own).finally(() => clearTimeout(timer));
  };
  // One checkout folder per slot, reset for each job it runs, since a fresh one cost 14 s per job (#5812) [P7].
  // A default-named serve keeps runner-<host> across restarts, so its warm trees and caches survive; one live serve holds it (#6705).
  const jobs = [], waits = [], slotName = runner ? { prefix: `runner-${id.replace(/[^A-Za-z0-9._-]/gu, '-')}`, release: () => {} } : claimSlotPrefix({ cache, host }), folders = slotName.prefix;
  let delay = firstMs;
  // Job environment folders a running job owns, which a prune never removes.
  const liveEnvironments = new Set();
  let prunedAt = 0;
  // Earlier serves' slot folders are dead once this one starts, so they go before the first job [P7]; a serve beside the host's holder leaves its folders alone.
  try { const gone = slotName.shared ? [] : await pruneStaleSlots({ cache, instance: folders }); if (gone.length) say(`removed ${gone.length} stale slot folder(s)`); } catch { /* Pruning is best effort. */ }
  // A killed serve ran no cleanup: its orphaned jobs' processes, Chrome above all, end before the first job (#7811).
  try { const left = await reapLeftovers([join(cache, 'env'), join(cache, 'work')]); say(`killed ${left.length} leftover process(es) of earlier jobs`); } catch { /* Sweeping is best effort. */ }
  /**
   * Prune old results and dead environment folders at most once an interval; a failure never stops serving.
   * With runners.yieldWhilePruning on, the walk runs beside the serve and gives the event loop back as it goes, so no held
   * lease lapses while it measures a large cache; off, it blocks the serve until it ends (#9025).
   */
  let pruning = null;
  const prune = () => {
    if (Date.now() - prunedAt < pruneMs || pruning) return;
    prunedAt = Date.now();
    const options = { root: dirname(cache), cache, live: liveEnvironments };
    const said = done => { if (done.removed.length) say(`pruned ${done.removed.length} old folder(s)`); };
    if (pruneYields) { pruning = pruneYielding(options).then(said, () => { /* Pruning is best effort. */ }).finally(() => { pruning = null; }); return; }
    try { said(pruneStores(options)); } catch { /* Pruning is best effort. */ }
  };
  /** Wait out an unreachable board, longer each time in a row, and note the wait. */
  let failures = 0;
  const backoff = async error => {
    say(`${error.message}; retrying in ${delay} ms`);
    // A board no request reaches, again and again, is likely blocked on this host: say once per streak what to fix.
    failures = error.network ? failures + 1 : 0;
    if (unreachableHint && failures === HINT_AFTER) say(`board still unreachable after ${failures} tries; likely cause: ${unreachableHint}`);
    waits.push(delay); await nap(delay); delay = Math.min(delay * 2, maxMs);
  };
  /** Call the board until it answers; only the board's own refusal ends the call. */
  const reliably = async call => {
    // One claim key names one claim: every retry of that claim sends it again, so the board hands back the lease the first try took [C7].
    const body = call.action === 'claim' ? { ...call, key: randomBytes(12).toString('hex') } : call;
    for (;;) {
      if (signal?.aborted) throw new Refused('RUNNER_STOPPED', 'the runner was stopped');
      try { const answer = await queueCall(endpoint, body, fetchImpl); delay = firstMs; failures = 0; return answer; }
      catch (error) { if (!(error instanceof BoardUnreachable)) throw error; await backoff(error); }
    }
  };
  /** Run a handled kind in this process and post its result as the receipt; a lost lease posts nothing. */
  const handled = async (claim, held, workCache, name) => {
    // A handled job (a land job's proof) runs for minutes between its own renew() calls, so the lease is kept in the
    // background as an argv job's is; renew() reads false only once the board refused the renewal (#7815).
    const lease = keepLease(held, claim.kind);
    const renew = async () => {
      if (lease.isLost()) return false;
      let renewed;
      try { renewed = (await queueCall(endpoint, { action: 'renew', ...held }, fetchImpl)).renewed !== false; }
      catch (error) {
        // An unreachable board keeps the job: the background renewal retries until the board answers.
        if (error instanceof BoardUnreachable) return !lease.isLost();
        renewed = false;
      }
      if (!renewed) lease.lose();
      return renewed;
    };
    try { return await runHandled(claim, held, workCache, name, renew); }
    finally { lease.stop(); }
  };
  /** Run a handled kind's handler under a lease the caller keeps, and post its result as the receipt. */
  const runHandled = async (claim, held, workCache, name, renew) => {
    let receipt, environment = null;
    // A land job's proof runs under the same environment a gate job does, so its ledger context key matches the gate's [P7].
    liveEnvironments.add(name);
    try {
      // A payload that names what moved to the job's request (a big proof) gets it back before the handler runs (#7766).
      if (Array.isArray(claim.payload?.requested) && claim.payload.requested.length) {
        const asked = await reliably({ action: 'request', ...held });
        claim = { ...claim, payload: { ...claim.payload, ...asked?.request?.land } };
      }
      // jobs.handBackUnrunnable: a land job whose shardProof run is missing goes back at once with that reason, before any fetch, not to a lapsed lease [C7,#9249].
      const unrunnable = handBackUnrunnable && claim.kind === 'land' ? unrunnableLandReason(claim.payload) : null;
      if (unrunnable) throw new Error(`[LAND_UNRUNNABLE] this runner cannot run the land job: ${unrunnable}; next: the board offers it again once the request is whole`);
      // The runner's own install rides as PULLBOARD_RUNNER_TOOLS, as a gate job's does, so a proof's trusted step judges a non-Pullboard fixture the same way (#7816).
      environment = jobEnvironment(cache, name, claim.job);
      receipt = await handlers[claim.kind](claim, { cache: workCache, renew, env: { ...environment.env, PULLBOARD_RUNNER_TOOLS: RUNNER_TOOLS } });
    } catch (error) {
      // A handler that could not run (a fetch, a full disk) is an infrastructure wait: hand the job back, never a red receipt.
      say(`releasing ${claim.job}: ${error?.message ?? error}`);
      await reliably({ action: 'release', ...held, reason: String(error?.message ?? error) }).catch(refusal => { if (refusal.code !== 'JOB_LEASE_MOVED') throw refusal; });
      return { outcome: 'released' };
    } finally {
      // Whatever the handler ended with, a proof that timed out included, nothing it started outlives it: processes naming its environment folder (a test's home and tmp) end before the receipt posts; never the landing checkout, which a runner may run its own code from (#7820).
      if (environment) {
        const survivors = await reapJob(claim.job, undefined, { folder: environment.folder, graceMs: reapMs }).catch(() => []);
        if (survivors.length) say(`killed ${survivors.length} leftover process(es) of ${claim.job}: ${survivors.join(' ')}`);
      }
      liveEnvironments.delete(name);
    }
    try {
      await postReceiptCalls(reliably, held, receipt);
      say(`posted ${claim.job}: ${receipt?.outcome ?? 'done'}`);
      return { outcome: 'posted', receipt };
    } catch (error) {
      if (error.code !== 'JOB_LEASE_MOVED' && error.code !== 'RUNNER_STOPPED') throw error;
      return { outcome: 'lost' };
    }
  };
  // Trunk fetch health, kept only when runners.fetchFailFast or runners.drainOnFetchFailure is on: the last failure and the failures in a row [#9024].
  let trunkDown = null, fetchFailures = 0, lastTrunk = null;
  const onFetch = reason => { if (reason) { fetchFailures += 1; trunkDown = { at: Date.now(), reason }; } else { fetchFailures = 0; trunkDown = null; } };
  /** The reason a waiting job is sent back without a fetch of its own: the trunk fetch failed moments ago. */
  const recentFetchFailure = () => trunkDown && Date.now() - trunkDown.at < fetchMemoMs ? `the trunk fetch failed ${Math.round((Date.now() - trunkDown.at) / 1000)} s ago: ${trunkDown.reason}` : null;
  /** Hand checkout work to the shared object cache one job at a time: concurrent fetches into one bare store race on its refs. */
  let cacheLock = Promise.resolve();
  const serially = work => { const turn = cacheLock.then(work, work); cacheLock = turn.catch(() => {}); return turn; };
  // With runners.fetchConcurrent on, fetches of different missing commits take up to 4 turns at once; the object store is still made, and checkouts dropped, one at a time [#9884].
  const fetchTurns = fetchConcurrent ? countingTurns(4) : null;
  /**
   * Run one claimed job in its slot and say how it ended; null when the runner stopped before it held anything.
   * Why a slot: concurrent jobs each own a checkout and, for handled kinds, a working folder, so no two share files.
   */
  const runClaim = async (claim, trunk, slot, self, known) => {
    const held = { job: claim.job, runner: id, token: claim.token }, claimedAt = Date.now();
    say(`claimed ${claim.job} (attempt ${claim.attempt}) at ${claim.candidate} in slot ${slot}`);
    if (Object.hasOwn(handlers, claim.kind)) { known(); return { job: claim.job, ...await handled(claim, held, slot === 0 ? cache : join(cache, 'slot', String(slot)), `${folders}-${slot}`) }; }
    // Renew from the claim on, through the request and the fetch too: a fetch longer than the 2-minute lease let another
    // runner take the job mid-fetch, and every job churned from runner to runner unrun (#5805).
    const lease = keepLease(held, claim.kind);
    try { return await runHeld(claim, trunk, slot, held, lease.isLost, lease.whenLost, claimedAt, self, known); }
    finally { lease.stop(); known(); if (exclusive === claim.job) exclusive = null; }
  };
  /**
   * Keep a held job's lease from its claim until stop(): renew every renewMs, and retry a renewal the board never
   * answered every few seconds, past the lease too. Only the board's answer that another runner holds the job loses it,
   * since the board renews a lapsed lease no one claimed (#6546); a handled job is kept the same way (#7815).
   */
  const keepLease = (held, kind = null) => {
    let lost = false, onLost = () => {}, renewedAt = Date.now(), timer = null, ended = false;
    const lose = () => { if (lost) return; lost = true; onLost(); };
    // A landing job's renewal carries a landing permit, so it keeps its own renew call; every other job joins the serve's one renew.
    if (kind !== 'land') {
      const entry = { held, lose, stamp: () => { renewedAt = Date.now(); }, since: () => renewedAt };
      shared.set(held.job, entry);
      if (!sharedTimer) sharedTimer = setTimeout(renewShared, renewMs);
      return { isLost: () => lost, lose, whenLost: stop => { onLost = stop; }, stop: () => {
        ended = true; shared.delete(held.job);
        if (!shared.size && sharedTimer) { clearTimeout(sharedTimer); sharedTimer = null; }
      } };
    }
    const renewOnce = () => {
      if (ended || lost) return;
      queueCall(endpoint, { action: 'renew', ...held }, fetchImpl).then(renewed => {
        if (renewed.renewed === false) { lose(); return; }
        renewedAt = Date.now(); if (!ended) timer = setTimeout(renewOnce, renewMs);
      }, error => {
        if (error instanceof Refused && error.code === 'JOB_LEASE_MOVED') { lose(); return; }
        say(`renewal ${Date.now() - renewedAt >= leaseMs ? 'still failing past the lease' : 'skipped'}: ${error.message}`); if (!ended) timer = setTimeout(renewOnce, renewRetryMs);
      });
    };
    timer = setTimeout(renewOnce, renewMs);
    return { isLost: () => lost, lose, whenLost: stop => { onLost = stop; }, stop: () => { ended = true; clearTimeout(timer); } };
  };
  /**
   * Renew every held job of this serve in one call every renewMs, not one call per job [C7,#12150]: the board names each job's
   * lease or the refusal code of a job this runner no longer holds, so one moved job loses only itself. An unreachable board
   * retries after renewRetryMs, past the lease too, as a single job's renewal does.
   */
  const shared = new Map();
  let sharedTimer = null;
  const renewShared = () => {
    sharedTimer = null;
    const entries = [...shared.values()];
    if (!entries.length) return;
    const next = ms => { if (shared.size && !sharedTimer) sharedTimer = setTimeout(renewShared, ms); };
    queueCall(endpoint, { action: 'renew', runner: id, held: entries.map(entry => entry.held) }, fetchImpl).then(answer => {
      const leases = new Map((Array.isArray(answer.leases) ? answer.leases : []).map(lease => [lease.job, lease]));
      for (const entry of entries) {
        const lease = leases.get(entry.held.job);
        if (lease?.renewed === false) { if (lease.refused === undefined || lease.refused === 'JOB_LEASE_MOVED') { entry.lose(); continue; } say(`renewal of ${entry.held.job} skipped: ${lease.refused}`); continue; }
        entry.stamp();
      }
      next(renewMs);
    }, error => {
      const stale = entries.some(entry => Date.now() - entry.since() >= leaseMs);
      say(`renewal ${stale ? 'still failing past the lease' : 'skipped'}: ${error.message}`); next(renewRetryMs);
    });
  };
  /** Fetch, run and report one claimed argv job while runClaim renews its lease; isLost reads whether the lease moved. */
  const runHeld = async (claim, trunk, slot, held, isLost, whenLost, claimedAt = Date.now(), self = () => null, known = () => {}) => {
    // A job offered with no run carries its argv and stdin in its request, which only the claim's holder reads [P7].
    let run = claim.run ?? [], input = null, also = claim.base ? [claim.base] : [], named = null, timed = false, ref = null, requestedEnv = null;
    const requestStart = Date.now();
    if (!run.length) {
      let asked;
      try { asked = await reliably({ action: 'request', ...held }); }
      catch (error) { known(); if (error.code === 'RUNNER_STOPPED') return null; if (error.code === 'JOB_LEASE_MOVED') return { job: claim.job, outcome: 'lost' }; throw error; }
      const request = asked?.request;
      if (Array.isArray(request?.run) && request.run.length) {
        run = request.run;
        input = JSON.stringify(request.input ?? null);
        named = Array.isArray(request.input?.data?.files) ? request.input.data.files.length : null;
        also = [...new Set([...also, ...(Array.isArray(request.commits) ? request.commits : [])])];
        ref = typeof request.ref === 'string' ? request.ref : null;
        requestedEnv = request.env ?? null;
        // A gate frozen with exclusive check timing holds the runner: nothing else is claimed from here until it ends [C7,#8187].
        timed = request.input?.data?.checkTiming === true;
        if (timed) exclusive = claim.job;
      }
    }
    known();
    // A request whose env names anything but a fixture switch never runs here: it goes back naming JOB_ENV_REFUSED [#10848].
    try { requestedJobEnvironment(requestedEnv); }
    catch (refusal) {
      const reason = `[${refusal.code}] ${refusal.message}`; say(`releasing ${claim.job}: ${reason}`);
      await reliably({ action: 'release', ...held, reason }).catch(error => { if (error.code !== 'JOB_LEASE_MOVED') throw error; });
      return { job: claim.job, outcome: 'released' };
    }
    const requestMs = Date.now() - requestStart;
    // A job whose request carries its input runs the gate bootstrap, a gate's or a pulled test's, and prints one receipt line [P7].
    const gate = input !== null;
    const name = `${claim.job.replace(/[^A-Za-z0-9._-]/gu, '-')}-${claim.attempt}`;
    // Each slot reuses its own folder: concurrent jobs never share one, and only the shared object store's writes take turns.
    let late = false, deadline = null;
    const fetching = checkoutCandidate(cache, trunk, claim.candidate, `${folders}-${slot}`, also, { main: claim.base ?? null, pack, exclusive: serially, ...(fetchTurns ? { fetchTurn: fetchTurns } : {}), git, ref,
      ...(fetchFailFast || drainOnFetchFailure ? { onFetch } : {}), ...(fetchFailFast ? { fetchGate: () => late ? 'the claim already went back to the queue' : recentFetchFailure() } : {}) });
    // With runners.fetchFailFast on, a fetch still running 120 s after the claim sends the job back naming that, and a fetch queued behind it never starts for this job [#9024].
    const checkout = await (fetchFailFast ? Promise.race([fetching, new Promise(resolve => {
      deadline = setTimeout(() => { late = true; resolve({ ok: false, reason: `the trunk fetch did not end within ${Math.round(fetchFailMs / 1000)} s of the claim${trunkDown ? `; the last failure was: ${trunkDown.reason}` : ''}` }); }, Math.max(0, fetchFailMs - (Date.now() - claimedAt)));
    })]).finally(() => clearTimeout(deadline)) : fetching);
    fetching.catch(() => {});
    if (!checkout.ok || !run.length) {
      // A candidate this runner cannot fetch is an infrastructure wait: hand the job back, never a red receipt.
      const reason = checkout.ok ? 'the job names nothing to run' : checkout.reason; say(`releasing ${claim.job}: ${reason}`);
      await reliably({ action: 'release', ...held, reason }).catch(error => { if (error.code !== 'JOB_LEASE_MOVED') throw error; });
      return { job: claim.job, outcome: 'released' };
    }
    if (isLost()) { say(`lost the lease on ${claim.job} while fetching it`); return { job: claim.job, outcome: 'lost' }; }
    // The timed check starts only once every job this serve held before it has ended, so its clock runs on an otherwise idle runner.
    if (timed) {
      for (;;) {
        const others = [...active].filter(task => task !== self());
        if (!others.length || isLost() || signal?.aborted) break;
        await Promise.race([...others, new Promise(resolve => setTimeout(resolve, renewMs))]);
      }
      if (isLost()) { say(`lost the lease on ${claim.job} while waiting for the runner to idle`); return { job: claim.job, outcome: 'lost' }; }
    }
    const started = Date.now();
    // Claim-to-command, in phases the receipt carries: the board's request, the commit download (waiting its turn included),
    // the checkout, and whether the slot's warm folder was reused.
    const startup = { version: 1, requestMs, fetchMs: checkout.phases.fetchMs, checkoutMs: checkout.phases.checkoutMs,
      reused: checkout.reused, totalMs: started - claimedAt };
    liveEnvironments.add(name);
    const job = jobEnvironment(cache, name, claim.job, environmentAdapter().all(), requestedEnv), tag = randomBytes(8).toString('hex');
    // The job's full output stays on this runner by job id; the receipt says where, beside its digest [P7].
    const kept = keepFolder(cache, claim.job, claim.attempt);
    // The run's test reporter appends each file's state to this file; it is posted as the job's progress step, lease-checked like the receipt (#5823).
    const progressFile = join(cache, 'progress', `${storeName(name, '.jsonl')}`);
    disk.mkdir(join(cache, 'progress'), { recursive: true }); disk.rm(progressFile, { force: true });
    const progress = watchProgress({ file: progressFile, selected: named, everyMs: timing.progressMs,
      post: body => queueCall(endpoint, { action: 'progress', ...held, progress: body }, fetchImpl) });
    // The job fetches any further commit it needs, such as a claim base on another item's branch, from this same trunk remote (#5808).
    // The gate bootstrap judges a project whose main is not Pullboard's tree with this runner's own install (#6265).
    const env = { ...job.env, PULLBOARD_RUNNER_TOOLS: RUNNER_TOOLS, [RUNNER_CLAIM_ENV]: tag, [JOB_WORKERS_ENV]: String(jobWorkers(slots, cores, named, jobWorkerFactor)), PULLBOARD_TRUNK_REMOTE: trunk, [PROGRESS_ENV]: progressFile, ...(kept ? { [RUNNER_OUTPUT_ENV]: kept } : {}) };
    const running = runJob(run[0] === 'node' ? [process.execPath, ...run.slice(1)] : run, checkout.folder, { ceilingMs, input, receiptLine: gate ? GATE_RECEIPT : null,
      env, keep: kept ? join(kept, 'job.log') : null });
    // An unreachable board only skips a renewal; a moved lease stops the job.
    whenLost(() => running.stop());
    if (isLost()) running.stop();
    // A stopped runner stops its job and hands it back at once, so the next puller need not wait out the lease.
    const stopping = () => running.stop();
    signal?.addEventListener('abort', stopping, { once: true });
    const result = await running.done.finally(() => { signal?.removeEventListener('abort', stopping); });
    const lost = isLost();
    // Every process the job started ends before its receipt posts, a detached one too: its group, then its marker (#5805).
    const survivors = await reapJob(claim.job, running.pid, { claim: tag, folder: [job.folder, job.temporary, checkout.folder], graceMs: reapMs });
    if (survivors.length) say(`killed ${survivors.length} leftover process(es) of ${claim.job}: ${survivors.join(' ')}`);
    await progress.stop(); disk.rm(progressFile, { force: true });
    // A leftover writer still filling tmp failed this with ENOTEMPTY and stopped the whole serve, draining 10 slots (#6307).
    // With gate.pulledProfilePaths on, each phase's timing profile is copied beside its log in the kept folder and named on its row (profileKept); the copy comes before the job's folder, which holds the profiles, is removed [C7,#9614].
    const keptGate = gate && pulledProfilePaths && kept ? keepGateProfiles(kept, gateReceipt(result, claim.candidate, 0).gate) : null;
    try { removeFolder(job.folder); } catch (error) { say(`left ${name}'s environment folder to the prune: ${error?.code ?? error}`); }
    liveEnvironments.delete(name);
    if (signal?.aborted && !lost) {
      await queueCall(endpoint, { action: 'release', ...held, reason: 'runner stopped', backoff: false }, fetchImpl).catch(() => { /* the lease lapses instead */ });
      return { job: claim.job, outcome: 'released' };
    }
    if (lost) { say(`lost the lease on ${claim.job}; another runner may hold it`); return { job: claim.job, outcome: 'lost' }; }
    // Exclusivity evidence: this serve took no other job from admission to finish, so the run's whole span was the runner's alone.
    const finishedAt = Date.now();
    const exclusiveEvidence = timed ? { timing: true, exclusive: true, unfencedClients: [], occupiedSlots: slots, admittedAt: new Date(started).toISOString(), finishedAt: new Date(finishedAt).toISOString() } : {};
    // With runners.postedLineNamesCase on, a red job's posted line ends naming its first failing case, so serve.log shows it without the board [#9084].
    const postedCase = outcome => { const named = postedLineNamesCase && outcome.status !== 0 ? firstFailingCase(outcome.tail) : ''; return named ? `; ${named}` : ''; };
    const receipt = { ...exclusiveEvidence, ...(gate ? { ...gateReceipt(result, claim.candidate, Date.now() - started), ...(keptGate ? { gate: keptGate } : {}) }
      : { status: result.status, signal: result.signal, commit: claim.candidate, run, outputSha256: result.outputSha256,
        outputBytes: result.outputBytes, tail: result.tail, durationMs: Date.now() - started }), startup, ...(kept ? { output: { runner: id, folder: kept } } : {}) };
    try {
      const answer = await postReceiptCalls(reliably, held, receipt);
      say(`posted ${claim.job}: exit ${result.status}${gate ? `, gate ${receipt.gate.green ? 'green' : 'red'}` : ''}${answer?.relayed ? `; ${answer.relayed.moves} board moves sent to the relay` : ''}${answer?.applied?.outcome ? `; board: ${answer.applied.outcome}${answer.applied.reason ? ` (${answer.applied.reason})` : ''}` : ''}${postedCase(result)}`);
      // A relay-linked board orders the receipt's moves through the relay; one it refused is named here, never lost (#7562).
      for (const why of answer?.relayed?.refused ?? []) say(`${claim.job}: the relay refused a receipt move: ${why}`);
      return { job: claim.job, outcome: 'posted', receipt };
    } catch (error) {
      if (error.code !== 'JOB_LEASE_MOVED' && error.code !== 'RUNNER_STOPPED') throw error;
      return { job: claim.job, outcome: 'lost' };
    }
  };
  // Claim until every slot holds a job, then claim again as each one ends: one serve uses the whole runner [P7].
  const active = new Set(), free = Array.from({ length: slots }, (_, slot) => slot);
  let failure = null;
  // The job holding the runner for exclusive check timing; nothing else is claimed while it is set [C7,#8187].
  let exclusive = null;
  // The drain: whether it was announced, and when the trunk was last probed [#9024].
  let drained = false, probedAt = 0;
  let yielding = false;
  // Loaded only by a serve handed a runnerCode port, so no cold command pays for it (the closure budgets).
  const codeWatch = runnerCode ? (await import('./pull/runner-code.js')).runnerCodeWatch(runnerCode, say) : null;
  let restart = null;
  const start = (claim, trunk) => {
    const slot = free.shift();
    let task, known;
    const learned = new Promise(resolve => { known = resolve; });
    task = runClaim(claim, trunk, slot, () => task, known).then(entry => { if (entry) jobs.push(entry); }, async error => {
      // A refusal that belongs to this one job (its receipt, its write, its hop) hands the job back and the serve keeps its other slots running [C7].
      if (!(error instanceof Refused) || !PER_JOB_REFUSALS.has(error.code)) { failure ??= error; return; }
      say(`releasing ${claim.job}: [${error.code}] ${error.message}`);
      await queueCall(endpoint, { action: 'release', job: claim.job, runner: id, token: claim.token, reason: `[${error.code}] ${error.message}` }, fetchImpl).catch(() => { /* the lease lapses instead */ });
      jobs.push({ job: claim.job, outcome: 'released' });
    })
      .finally(() => { ledger.drop(claim.kind); active.delete(task); free.push(slot); free.sort((a, b) => a - b); });
    active.add(task);
    task.learned = learned;
    return task;
  };
  while (!signal?.aborted && !failure) {
    prune();
    if (active.size >= slots) { await Promise.race(active); continue; }
    if (exclusive) { await Promise.race(active); continue; }
    // With runners.drainOnFetchFailure on, a trunk that failed 3 fetches in a row gets no new claim until a probe of it answers [#9024].
    if (fetchFailures < DRAIN_AFTER) drained = false;
    if (drainOnFetchFailure && fetchFailures >= DRAIN_AFTER) {
      if (!drained) { drained = true; say(`not claiming: ${fetchFailures} trunk fetches failed in a row (${trunkDown?.reason ?? 'no reason given'}); probing the trunk until it answers`); }
      if (lastTrunk && Date.now() - probedAt >= drainProbeMs) {
        probedAt = Date.now();
        const probe = await git.run(join(cache, 'git'), ['ls-remote', '--exit-code', lastTrunk, 'HEAD']).catch(() => ({ status: 1 }));
        if (probe.status === 0) { fetchFailures = 0; trunkDown = null; drained = false; say('the trunk answers again; claiming'); continue; }
      }
      await Promise.race([nap(idleMs), ...active]); continue;
    }
    // One serve claims per host: a daemon copy waits idle while the GUI-session copy of its install runs, so a GUI login never leaves two serves pulling one cache (#10840).
    if (peer && peer.session !== 'gui') {
      const gui = await Promise.resolve().then(() => peer.guiRunning()).catch(() => false);
      if (gui) {
        if (!yielding) { yielding = true; say('not claiming: the GUI-session serve of this install is running'); }
        if (once) break;
        await Promise.race([nap(idleMs), ...active]); continue;
      }
      if (yielding) { yielding = false; say('the GUI-session serve is gone; claiming'); }
    }
    // Admission and claim take one turn of the machine's ledger, and a claimed kind is held before the turn ends, so a
    // serve of another board on this machine admits against it; a kind admission excepts is skipped by the claim [C7,#10794].
    let answer;
    try {
      answer = await ledger.claiming(async () => {
        const admitted = admit({ running: active.size, held: ledger.list() });
        if (!admitted) return null;
        const except = Array.isArray(admitted?.except) && admitted.except.length ? { except: admitted.except } : {};
        const claimed = await reliably({ action: 'claim', runner: id, place: { host, root: cache }, capabilities, ...except, jobs: slots, cores, ram: totalmem() });
        if (claimed.claim) ledger.add(claimed.claim.kind);
        return claimed;
      });
    } catch (error) {
      if (error.code === 'RUNNER_STOPPED') break;
      // A duplicate runner never serves: the board names it, so the serve ends with that error instead of waiting it out [C7].
      if (!(error instanceof Refused) || error.code === 'RUNNER_DUPLICATE') { failure = error; break; }
      // A refused claim call is a wait like an unreachable board: said, backed off, tried again; only the signal ends the serve.
      say(`claim refused: [${error.code}] ${error.message}; retrying in ${delay} ms`);
      waits.push(delay); await nap(delay); delay = Math.min(delay * 2, maxMs);
      continue;
    }
    if (!answer) {
      if (once) { say('not claiming: the machine is over its load share'); break; }
      await Promise.race([nap(idleMs), ...active]); continue;
    }
    const updating = await codeWatch?.due(answer.runnerCommit);
    if (!answer.claim && !updating) {
      // A one-job runner, such as a sandbox or an ephemeral CI container, exits on an empty queue instead of idling [P7].
      if (once) { say('nothing to claim: the queue is empty'); break; }
      // A claim a runner's own cap held back carries the time to wait, so a full runner does not poll every idleMs [C7,#12150].
      const waitMs = Number.isFinite(answer.waitMs) && answer.waitMs > 0 ? answer.waitMs : idleMs;
      await Promise.race([wake ? (stopped ? Promise.race([wake.nap(waitMs), stopped]) : wake.nap(waitMs)) : nap(waitMs), ...active]); continue;
    }
    if (answer.claim) {
      lastTrunk = answer.trunk;
      const task = start(answer.claim, answer.trunk);
      if (once) { await task; break; }
      // The next claim waits for this job to say whether it holds the runner, so a timed gate is never claimed beside another [C7,#8187].
      if (!updating) await Promise.race([task.learned, task]);
    }
    if (updating) {
      await Promise.all(active);
      if (!failure && await codeWatch.apply(updating)) { restart = updating; break; }
    }
  }
  await Promise.all(active);
  await pruning;
  slotName.release();
  if (failure) throw failure;
  return { jobs, waits, slots, ...(restart ? { restart } : {}) };
}
