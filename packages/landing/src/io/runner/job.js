/** The runner side of a landing job: fetch trunk, merge the accepted items, check, and push only if trunk has not moved [P7]. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from '../../../../git/index.js';
import { permitPushOptions } from '../../../../git/index.js';

/** The board's landing job kind, as packages/api offers it. */
export const LANDING_JOB_KIND = 'land';
// Budget: a landing whose push keeps finding trunk moved tries this many tips, then hands the job back as trunk-busy.
const PUSH_ATTEMPTS = 5;
const TRUNK_CACHE = 'refs/pullboard/landing/trunk';
export const IDENTITY = ['-c', 'user.name=Pullboard', '-c', 'user.email=landing@pullboard.invalid', '-c', 'core.hooksPath=/dev/null'];
// A push into the board host's own checkout updates its checked-out trunk and work tree, and refuses if that tree is dirty.
export const INTO_CHECKOUT = '--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack';
const NO_PUSH_OPTIONS = /does not support push options/u;

/**
 * Push the landed tip with compare-and-swap, carrying the job's landing permit as push options for the trunk guard
 * (#5848). A remote with no guard may not take push options at all; the push then goes again without them.
 */
export function pushTrunk(root, { payload, trunk, base, remote, source = 'HEAD', options = [] }) {
  const push = extra => tryGit(root, ['push', '--porcelain', '--quiet', ...(payload.checkout ? [INTO_CHECKOUT] : []), ...extra, `--force-with-lease=${trunk}:${base}`, remote, `${source}:${trunk}`]);
  const pushed = push(options.flatMap(option => ['-o', option]));
  return options.length && pushed.status !== 0 && NO_PUSH_OPTIONS.test(pushed.stderr) ? push([]) : pushed;
}

/** Run git in the runner's landing checkout; throw with git's own words when it fails. */
export function must(root, args) {
  const result = tryGit(root, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
  return result.stdout;
}

/** The runner's landing checkout: a cache it can rebuild, never a durable home for work. */
export function landingCheckout(workdir) {
  mkdirSync(workdir, { recursive: true });
  if (!existsSync(join(workdir, '.git'))) must(workdir, ['init', '-q']);
  return workdir;
}

/** Fetch the trunk remote's current tip; null when the remote has no trunk yet. */
export function fetchTrunk(root, remote, trunk) {
  const fetched = tryGit(root, ['fetch', '--no-tags', '--quiet', remote, `+${trunk}:${TRUNK_CACHE}`]);
  if (fetched.status !== 0) throw new Error(`git fetch of ${trunk} failed: ${fetched.stderr.slice(0, 300)}`);
  return must(root, ['rev-parse', '--verify', `${TRUNK_CACHE}^{commit}`]);
}

/** Fetch one accepted item from the trunk remote and confirm it is still the accepted commit. */
export function fetchItem(root, remote, entry) {
  const local = `refs/pullboard/landing/item/${entry.id}`;
  const fetched = tryGit(root, ['fetch', '--no-tags', '--quiet', remote, `+${entry.ref ?? entry.commit}:${local}`]);
  if (fetched.status !== 0) return { moved: `the trunk remote does not serve ${entry.ref ?? entry.commit}` };
  const commit = tryGit(root, ['rev-parse', '--verify', `${local}^{commit}`]).stdout;
  return commit === entry.commit ? { moved: null } : { moved: `${entry.ref} is at ${commit.slice(0, 12)}, not the accepted ${entry.commit.slice(0, 12)}` };
}

/** The spec ids an item's own subject cites, so the landing merge cites them too, as today's lander does. */
export function citedIds(root, commit) {
  const subject = tryGit(root, ['log', '-1', '--format=%s', commit]).stdout;
  return /\[([A-Z][0-9A-Za-z.,\s]*)\]\s*$/u.exec(subject)?.[1] ?? 'P7';
}

/** Run the job's check command in the merged tree; exit 0 is green. */
export function commandCheck(argv) {
  return ({ root }) => new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, stdio: 'ignore' });
    child.on('error', error => resolve({ ok: false, detail: String(error.message).slice(0, 300) }));
    child.on('exit', (code, signal) => resolve({ ok: code === 0, detail: code === 0 ? null : `check exited ${code ?? signal}` }));
  });
}

/**
 * Land one job's accepted items on the trunk remote, from a runner. Each attempt fetches trunk, skips items trunk
 * already holds, merges the rest on that tip with --no-ff, runs the check on the merged tree, and pushes with
 * --force-with-lease=<trunk>:<the tip it merged on>: git's compare-and-swap, so the push lands only if trunk is still
 * exactly that tip. A push that finds trunk moved starts again on the new tip, so a landing never publishes a tree it
 * did not check, never lands on a stale base, and never overwrites a rival's landing.
 *
 * @param {{ remote: string, trunk: string, expect: string, items: { id: number, commit: string, ref?: string }[], check?: string[], checkout?: boolean }} payload - checkout:
 *   the remote is the board host's checkout, whose checked-out trunk the push updates in place [P7].
 * @param {{ workdir: string, checks?: (context: { root: string, base: string, items: number[], renew: () => Promise<boolean> | boolean }) => Promise<{ ok: boolean, detail?: string | null }> | { ok: boolean, detail?: string | null },
 *   renew?: () => boolean | Promise<boolean>, attempts?: number, pushOptions?: () => string[] }} options - pushOptions: the current lease's landing permit as git push options.
 * @returns {Promise<{ kind: string, outcome: 'landed' | 'conflict' | 'red' | 'item-moved' | 'trunk-busy' | 'lease-lost' | 'push-failed',
 *   expect: string, base: string | null, trunk: string | null, landed: number[], already: number[], attempts: number, moved: string[], detail: string | null }>}
 */
export async function runLandingJob(payload, { workdir, checks = null, renew = () => true, attempts = PUSH_ATTEMPTS, pushOptions = () => [] }) {
  const { remote, trunk, expect, items } = payload;
  // A job carrying a ledger proof runs only its misses on the merged tree; the module loads only then, off the worker bundle [P7].
  const check = checks ?? (payload.check ? commandCheck(payload.check)
    : payload.proof ? (await import('./proof.js')).ledgerProofCheck(payload.proof) : () => ({ ok: true, detail: null }));
  const root = landingCheckout(workdir);
  const receipt = { kind: LANDING_JOB_KIND, outcome: 'trunk-busy', expect, base: null, trunk: null, landed: [], already: [], attempts: 0, moved: [], detail: null };
  const done = (outcome, fields = {}) => Object.assign(receipt, { outcome }, fields);
  for (const entry of items) {
    const fetched = fetchItem(root, remote, entry);
    if (fetched.moved) return done('item-moved', { detail: `#${entry.id}: ${fetched.moved}` });
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    receipt.attempts = attempt;
    const base = fetchTrunk(root, remote, trunk);
    if (base !== (receipt.base ?? expect)) receipt.moved.push(base);
    receipt.base = base;
    const already = items.filter(entry => tryGit(root, ['merge-base', '--is-ancestor', entry.commit, base]).status === 0).map(entry => entry.id);
    const pending = items.filter(entry => !already.includes(entry.id));
    receipt.already = already;
    if (pending.length === 0) return done('landed', { trunk: base, landed: [] });
    must(root, ['checkout', '-q', '--detach', '--force', base]);
    must(root, ['clean', '-q', '-fd']);
    for (const entry of pending) {
      const merged = tryGit(root, [...IDENTITY, 'merge', '--no-ff', '--no-edit', '-q', '-m', `Merge #${entry.id} onto main [${citedIds(root, entry.commit)}]`, entry.commit]);
      if (merged.status !== 0) {
        tryGit(root, ['merge', '--abort']);
        return done('conflict', { detail: `#${entry.id} does not merge on ${base.slice(0, 12)}: ${(merged.stdout || merged.stderr).slice(0, 240)}` });
      }
    }
    // Renew around the check: a check longer than the lease may let a second runner take the job, which is safe, since
    // the push's compare-and-swap and the on-trunk skip keep a duplicate landing from losing or doubling a commit.
    if (!await renew()) return done('lease-lost', { detail: 'the job\'s lease moved to another runner before its check' });
    const result = await check({ root, base, items: pending.map(entry => entry.id), renew });
    if (result?.proof) receipt.proof = result.proof;
    if (!result?.ok) return done('red', { detail: result?.detail ?? 'the landing check failed' });
    if (!await renew()) return done('lease-lost', { detail: 'the job\'s lease moved to another runner before the push' });
    const tip = must(root, ['rev-parse', 'HEAD']);
    const pushed = pushTrunk(root, { payload, trunk, base, remote, options: pushOptions() });
    if (pushed.status === 0) return done('landed', { trunk: tip, landed: pending.map(entry => entry.id) });
    // A refused push is a moved trunk only when trunk really moved; anything else is a push failure to report.
    if (fetchTrunk(root, remote, trunk) === base) return done('push-failed', { detail: (pushed.stderr || pushed.stdout).slice(0, 300) });
  }
  return done('trunk-busy', { detail: `trunk moved under each of ${attempts} attempts; offer the landing again` });
}

/**
 * Take one landing job from the board and run it: claim by kind, land, post the receipt. `call` is the board API's
 * job queue call (`{ action: 'claim' | 'renew' | 'receipt', ... }`), local or over HTTPS; this runner never opens
 * the board's database, and the board never runs a landing step.
 *
 * @param {{ call: (body: object) => object | Promise<object>, runner: string, capabilities?: string[], workdir: string,
 *   checks?: Parameters<typeof runLandingJob>[1]['checks'] }} options
 * @returns {Promise<{ job: string, receipt: Awaited<ReturnType<typeof runLandingJob>>, recorded: boolean } | null>} null when no landing waits.
 */
export async function takeLandingJob({ call, runner, capabilities = [], workdir, checks = null }) {
  const { claim } = await call({ action: 'claim', runner, capabilities, kinds: [LANDING_JOB_KIND] });
  if (!claim) return null;
  const { job, token } = claim;
  // The board's landing permit for the current lease; each renewal returns the next one (#5848).
  let permit = claim.permit ?? null;
  const renew = async () => {
    try {
      const renewed = await call({ action: 'renew', job, runner, token });
      if (renewed.permit) permit = renewed.permit;
      return Boolean(renewed.renewed);
    } catch { return false; }
  };
  const receipt = await runLandingJob(claim.payload, { workdir, checks, renew, pushOptions: () => permit ? permitPushOptions(permit) : [] });
  try {
    const posted = await call({ action: 'receipt', job, runner, token, receipt });
    return { job, receipt, recorded: Boolean(posted.recorded) };
  } catch (error) {
    if (error?.code !== 'JOB_LEASE_MOVED') throw error;
    return { job, receipt, recorded: false };
  }
}
