/** The runner side of a landing job: fetch trunk, merge the accepted items, check, and push only if trunk has not moved [P7]. */
import { environmentAdapter } from '../../../../env/index.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { tryGit } from '../../../../git/index.js';
import { permitPushOptions } from '../../../../git/index.js';
import { gitSpawn } from '../../../../git/index.js';
import { RUNNER_POLICY_FILE } from '../../../../sandbox/light.js';
import { runnerPolicyRecord } from '../../../../sandbox/light.js';
import { itemKeepRef } from '../land/squash.js';
import { squashOnto } from '../land/squash.js';
import { amendLandingEngines } from '../derive.js';
import { amendLandingRegistries } from '../derive.js';
import { LANDING_STALL_MS } from '../progress.js';
import { landingStallDescription } from '../progress.js';
import { landingStallExpired } from '../progress.js';
import { LAND_PROOF_TIMEOUT } from './deadline.js';
import { proofLimitMs } from './deadline.js';
import { timeoutDetail } from './deadline.js';
import { stopTree } from './deadline.js';
import { watchDeadline } from './deadline.js';
import { IDENTITY } from '../land/merge-args.js';
import { citedIds } from '../land/merge-args.js';
import { landingMergeArgs } from '../land/merge-args.js';
import { commitUnionedMerge } from '../land/registry-union.js';

/** The environment this file reads, through the one adapter [C7]. */
const environment = environmentAdapter();
export { IDENTITY, citedIds, landingMergeArgs };

/** The board's landing job kind, as packages/api offers it. */
export const LANDING_JOB_KIND = 'land';
// Budget: a landing whose push keeps finding trunk moved tries this many tips, then hands the job back as trunk-busy.
const PUSH_ATTEMPTS = 5;
/**
 * The newest land payload shape this runner's code understands (packages/api's LAND_PAYLOAD_SHAPE is what the board writes).
 * A job of a newer shape is refused, never pushed without the options this code never learned (#7791). Shape 3: `hops`, each item's gate hop epoch, pushed through its fence ref [C7,#8437].
 */
export const LANDING_PAYLOAD_SHAPE = 3;
const TRUNK_CACHE = 'refs/pullboard/landing/trunk';
/** The release tags a trunk fetch also takes, as a runner's gate checkout does: a proof that archives an old release (git archive v0.8.6) needs them (#7816). */
const RELEASE_TAGS = '+refs/tags/v*:refs/tags/v*';
// A push into the board host's own checkout updates its checked-out trunk and work tree, and refuses if that tree is dirty.
export const INTO_CHECKOUT = '--receive-pack=git -c receive.denyCurrentBranch=updateInstead receive-pack';
const NO_PUSH_OPTIONS = /does not support push options/u;
// An ssh trunk remote whose login accepts only plain git commands rejects the custom --receive-pack (#7952).
const CUSTOM_REFUSED = /unrecognized command|command not allowed|not allowed to run|restricted shell/iu;
const CHECKED_OUT = /refusing to update checked out branch|branch is currently checked out/u;
// A trunk hook (the remote's pre-receive or update, or a local pre-push) that refused the push: git names it in its refusal line.
const HOOK_REFUSED = /hook declined|pre-push hook|hook (?:exited|failed)/iu;
const DIRTY_CHECKOUT = /Working directory has (?:unstaged|staged) changes|Could not update working tree/u;

/**
 * Push the landed tip with compare-and-swap, carrying the job's landing permit as push options for the trunk guard
 * (#5848). A remote with no guard may not take push options at all; the push then goes again without them. A remote
 * that refuses because trunk is checked out there takes the push into its checkout, as payload.checkout asks, since an
 * offer can miss a checkout it cannot see (#7951). A remote whose login refuses that custom receive-pack (an ssh shell
 * limited to plain git commands) gets one plain push instead, which lands when the trunk repo sets
 * receive.denyCurrentBranch=updateInstead itself (#7952).
 */
export function pushTrunk(root, { payload, trunk, base, remote, source = 'HEAD', options = [], fence = null }) {
  // fence: the hop fence leases and refspecs (publish.js hopFencePush), so trunk and each item's fence ref move in one atomic push [C7,#8437].
  const send = (into, extra) => tryGit(root, ['push', '--porcelain', '--quiet', ...(fence ? ['--atomic'] : []), ...(into ? [INTO_CHECKOUT] : []), ...extra,
    ...(fence?.leases ?? []), `--force-with-lease=${trunk}:${base}`, remote, ...(fence?.refspecs ?? []), `${source}:${trunk}`]);
  const push = into => {
    const pushed = send(into, options.flatMap(option => ['-o', option]));
    return options.length && pushed.status !== 0 && NO_PUSH_OPTIONS.test(pushed.stderr) ? send(into, []) : pushed;
  };
  const words = result => `${result.stderr}\n${result.stdout}`;
  const pushed = push(Boolean(payload.checkout));
  const into = !payload.checkout && pushed.status !== 0 && CHECKED_OUT.test(words(pushed)) ? push(true) : pushed;
  return (payload.checkout || into !== pushed) && into.status !== 0 && CUSTOM_REFUSED.test(words(into)) ? push(false) : into;
}

/**
 * A refused push's receipt detail: git's words, led by a plain LAND_HOST_CHECKOUT_DIRTY line when the board host's
 * checkout holds uncommitted changes, which updateInstead refuses to overwrite. Why: git's "(Working directory has
 * unstaged changes)" never said which tree or what to do (#7951).
 */
export function pushFailedDetail(pushed, remote, trunk) {
  const words = (pushed.stderr || pushed.stdout).slice(0, 300);
  if (!DIRTY_CHECKOUT.test(`${pushed.stderr}\n${pushed.stdout}`)) return words;
  return `LAND_HOST_CHECKOUT_DIRTY: the board host checkout at ${remote} has uncommitted changes, so it cannot take ${trunk}; next: commit or stash them in that checkout, then run pullboard land to offer the landing again. git: ${words}`;
}

/**
 * Whether a refused push was refused by a trunk hook, and the hook's own words when it was, else null.
 * Why: a hook's refusal is about the landing, not the host, so the items go back to their builders with the hook's reason instead of a retry loop [C7,P7].
 */
export function hookRefusal(pushed) {
  const said = `${pushed.stderr}\n${pushed.stdout}`;
  if (!HOOK_REFUSED.test(said)) return null;
  const lines = said.split('\n').map(line => line.replace(/^remote:\s?/u, '').trim()).filter(Boolean);
  return lines.join('\n').slice(0, 800);
}

/**
 * After a landing into the board host's checkout, push the landed tip on to that checkout's own upstream (its origin),
 * fast-forward only, with the landing permit; returns the receipt fields it adds. Why: with no trunk remote of record the
 * job lands into the host checkout, and the Mac engine also published the tip to origin, so origin must not lag [B3,C7,#7398].
 */
export function publishUpstream(root, { payload, trunk, tip, options = [] }) {
  if (typeof payload.upstream !== 'string' || !payload.upstream) return {};
  const push = extra => tryGit(root, ['push', '--porcelain', '--quiet', ...extra, payload.upstream, `${tip}:${trunk}`]);
  const first = push(options.flatMap(option => ['-o', option]));
  const pushed = options.length && first.status !== 0 && NO_PUSH_OPTIONS.test(first.stderr) ? push([]) : first;
  if (pushed.status === 0) return { published: tip };
  return { published: null, detail: `landed on the board host's trunk, but its upstream refused ${tip.slice(0, 12)}: ${(pushed.stderr || pushed.stdout).slice(0, 240)}` };
}

/** Run git in the runner's landing checkout; throw with git's own words when it fails. */
export function must(root, args) {
  const result = tryGit(root, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
  return result.stdout;
}

/**
 * Run one landing phase and push its elapsed milliseconds onto `phases`, even when it throws, as the batch landing's
 * timedPhase said each phase. Why: a pulled landing's receipt is where a slow merge, static guard or CLI smoke reads its own time [C7,B3].
 */
async function timed(phases, name, work) {
  const start = Date.now();
  try { return await work(); } finally { phases?.push({ phase: name, ms: Date.now() - start }); }
}

/** The runner's landing checkout: a cache it can rebuild, never a durable home for work. */
export function landingCheckout(workdir) {
  mkdirSync(workdir, { recursive: true });
  if (!existsSync(join(workdir, '.git'))) must(workdir, ['init', '-q']);
  return workdir;
}

/** Fetch the trunk remote's current tip and its release tags; null when the remote has no trunk yet. */
export function fetchTrunk(root, remote, trunk) {
  const fetched = tryGit(root, ['fetch', '--no-tags', '--quiet', remote, `+${trunk}:${TRUNK_CACHE}`, RELEASE_TAGS]);
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

/**
 * Run git fetch with the async spawn, so the event loop (the lease renewal, the stall watch) keeps running while it works.
 * Why: one synchronous fetch on a cold workdir outlasts the 2-minute lease, and git blocks the process that spawned it [C7,#9516].
 */
function fetchAsync(root, args) {
  return new Promise(resolve => {
    const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...env } = environment.all();
    let stderr = '', child;
    try { child = gitSpawn(['-C', root, 'fetch', '--no-tags', '--quiet', ...args], { stdio: ['ignore', 'ignore', 'pipe'], env }); }
    catch (error) { resolve({ status: 1, stderr: String(error.message) }); return; }
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    child.on('error', error => resolve({ status: 1, stderr: String(error.message) }));
    child.on('close', code => resolve({ status: code ?? 1, stderr: stderr.trim() }));
  });
}

/** fetchTrunk without blocking the event loop, behind landing.asyncFetch [C7,#9516]. */
export async function fetchTrunkAsync(root, remote, trunk) {
  const fetched = await fetchAsync(root, [remote, `+${trunk}:${TRUNK_CACHE}`, RELEASE_TAGS]);
  if (fetched.status !== 0) throw new Error(`git fetch of ${trunk} failed: ${fetched.stderr.slice(0, 300)}`);
  return must(root, ['rev-parse', '--verify', `${TRUNK_CACHE}^{commit}`]);
}

/** fetchItem without blocking the event loop, behind landing.asyncFetch [C7,#9516]. */
export async function fetchItemAsync(root, remote, entry) {
  const local = `refs/pullboard/landing/item/${entry.id}`;
  const fetched = await fetchAsync(root, [remote, `+${entry.ref ?? entry.commit}:${local}`]);
  if (fetched.status !== 0) return { moved: `the trunk remote does not serve ${entry.ref ?? entry.commit}` };
  const commit = tryGit(root, ['rev-parse', '--verify', `${local}^{commit}`]).stdout;
  return commit === entry.commit ? { moved: null } : { moved: `${entry.ref} is at ${commit.slice(0, 12)}, not the accepted ${entry.commit.slice(0, 12)}` };
}

/**
 * Admit the trunk the merge sits on: point the trunk ref at the base and write the runner policy record for the merged
 * HEAD, as a runner's gate checkout carries it. Why: the landing checkout is a detached clone with no primary branch,
 * so run-tests' committed-policy readers refused NO_POLICY and every ledger-proved land job went red (#6179) [P7].
 */
export function admitTrunk(root, { trunk, base }) {
  // Only a branch can be a carried trunk; a landing onto any other ref keeps today's checkout.
  if (!/^refs\/heads\/[\w./-]+$/u.test(trunk) || trunk.includes('..')) return;
  must(root, ['update-ref', trunk, base]);
  const record = runnerPolicyRecord({ id: randomUUID(), commit: must(root, ['rev-parse', 'HEAD']), tree: must(root, ['rev-parse', 'HEAD^{tree}']), trunk: { ref: trunk, commit: base } });
  writeFileSync(join(root, '.git', RUNNER_POLICY_FILE), JSON.stringify(record), { mode: 0o600 });
}

// A failing test's first line in TAP ("not ok 3 - name") or the spec reporter ("✖ name"), and the lines after it.
const FAILED_CASE = /^\s*(?:not ok \d+|\u2716 )/u;

/**
 * Run one check command in the merged tree; exit 0 is green. Its red names the command and its first failing case with
 * the lines after it, so the item's builder reads which case failed, as 0.9.3's landing told them [P7].
 * A `deadline` ({ at, ms }, or null) that passes first stops the command's process tree and returns `timeout: true`, never a red [C7,#7820].
 */
export function commandCheck(argv, { deadline = null } = {}) {
  return ({ root, progress = null, signal = null }) => new Promise(resolve => {
    // An enclosing node --test run's context never reaches the project's check, which then reports as its own run.
    const { NODE_TEST_CONTEXT, ...env } = environment.all();
    const child = spawn(argv[0], argv.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env });
    const named = argv.at(-1).slice(0, 200);
    let output = '', settled = false;
    const clear = watchDeadline(child, deadline, limitMs => {
      if (settled) return undefined;
      settled = true;
      const result = { ok: false, timeout: true, detail: timeoutDetail(`check ${named}`, limitMs, output) };
      return () => resolve(result);
    });
    const keep = chunk => { progress?.(); if (output.length < 200_000) output += chunk.toString('utf8'); };
    // landing.stallStop: a stall stops this command's tree; the stalled result is already posted by the job, so this close is ignored [C7,#8749].
    signal?.addEventListener('abort', () => { settled = true; stopTree(child).then(() => resolve({ ok: false, timeout: true, detail: 'stalled' })); }, { once: true });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', error => { clear(); if (!settled) { settled = true; resolve({ ok: false, detail: `${named}: ${String(error.message).slice(0, 300)}` }); } });
    child.on('close', (code, signal) => {
      clear();
      if (settled) return;
      settled = true;
      if (code === 0) return resolve({ ok: true, detail: null });
      const lines = output.split('\n');
      const at = lines.findIndex(line => FAILED_CASE.test(line));
      const failed = at < 0 ? lines.filter(Boolean).slice(-8) : lines.slice(at, at + 12);
      resolve({ ok: false, detail: `check ${named} exited ${code ?? signal}: ${failed.join('\n').trim().slice(0, 600)}`, output, code });
    });
  });
}

/**
 * The controller's two landing guards on the merged tree: the composed module-parse and resolution guard over the
 * lines merged since the base, then the candidate's CLI smoke on a scratch board. A refusal is the check's red, named
 * by its code. Why: a pulled land job ran neither, so a duplicate import or a broken help reached trunk [C7,#7307].
 */
function landingGuards(payload, phases) {
  return async ({ root, base }) => {
    try {
      const guards = await import('../guards.js');
      await guards.requireLandingModuleResolution(root, base, 'HEAD');
      await timed(phases, 'cli smoke', async () => (await import('../smoke.js')).runLandingCliSmoke(root));
      return { ok: true, detail: null };
    } catch (error) {
      if (!error?.code) throw error;
      return { ok: false, detail: `${error.code}: ${String(error.message).slice(0, 600)}` };
    }
  };
}

/**
 * The land job's check of the items merged so far: the landing guards, each merged item's own check, the job's command,
 * the ledger proof over the proved files the merged tree holds, then the contracts, stopping at the first red. Why the file filter: a
 * culprit search merges items one at a time, and a file only a later item adds is not in that tree yet [P7].
 */
async function landingCheck(payload, env, phases = null, shards = null) {
  const prove = payload.proof || payload.deferred ? (await import('./proof.js')).ledgerProofCheck : null;
  // landing.shardProof: the proof's files run as shard jobs on other runners when the offer carries the gate to run them, else on this runner [C7,#7818].
  const sharded = payload.shardProof && shards ? (await import('./shard-proof.js')).shardedProofCheck : null;
  // One deadline for the whole check, set when it starts: every command and the proof stop their trees when it passes (#7820).
  const limit = proofLimitMs(payload, env);
  let deadlineAt = null;
  const deadline = () => deadlineAt === null || limit === null ? null : { at: deadlineAt, ms: limit };
  // landing.reofferTrunkBusy: a green static check stands on a new trunk tip whose commits miss the batch's files [C7,#9103].
  const carry = payload.reofferTrunkBusy === true && payload.staticChecks ? (await import('./static-carry.js')).staticCarry({ enabled: true }) : null;
  return async context => {
    if (limit !== null) deadlineAt = Date.now() + limit;
    const merged = new Set(context.items);
    const files = (payload.proof?.files ?? []).filter(file => existsSync(join(context.root, file)));
    // role: which of the item's own check and the job's proof a red came from, so a paired rerun uses that command's runner.
    // The board's staticChecks guard runs on the merged tree before any test; its red returns the item that turned it red [C7,#7492].
    const staticGuard = payload.staticChecks ? (await import('./static.js')).staticGuardCheck(payload.staticChecks, argv => commandCheck(argv, { deadline }), { affectedOnly: payload.staticAffectedOnly === true }) : null;
    const proveFiles = own => {
      const here = prove(own, { env, waivers: Array.isArray(payload.waivers) ? payload.waivers : [], deadline, reuseGate: payload.reuseGateReceipts === true });
      return sharded ? sharded(own, { ...shards, gate: payload.shardProof, deadline, reuseGate: payload.reuseGateReceipts === true }, here) : here;
    };
    // The proof and the contracts each record the milliseconds they spent, red or not, so a slow land reads its own split [C7,#9245].
    const phaseOf = (name, part) => context => timed(phases, name, () => part(context));
    const timedGuard = staticGuard && (context => timed(phases, 'static checks', () => staticGuard(context)));
    const guard = timedGuard && carry ? (context => carry(context, timedGuard)) : timedGuard;
    // The payload's install command (check.install) prepares the landing checkout before any check, so item checks find their dependencies [C7,#12232].
    const install = typeof payload.install === 'string' && payload.install.trim() ? [['install', phaseOf('install', commandCheck(['sh', '-c', payload.install], { deadline }))]] : [];
    const parts = [...install, ['check', landingGuards(payload, phases)], ...(guard ? [['check', guard]] : []), ...payload.items.filter(entry => merged.has(entry.id) && typeof payload.checks?.[entry.id] === 'string').map(entry => ['check', commandCheck(['sh', '-c', payload.checks[entry.id]], { deadline })]),
      ...(payload.check ? [['proof', phaseOf('proof', commandCheck(payload.check, { deadline }))]] : []),
      ...(prove && files.length ? [['proof', phaseOf('proof', proveFiles({ ...payload.proof, files })), payload.proof?.runner]] : [])];
    // Files an item's submit deferred to this landing run on the merged tree once their item is in it; a red returns the item [C7].
    const deferred = payload.deferred && typeof payload.deferred.runner === 'string' ? payload.deferred : null;
    if (deferred && prove) for (const entry of payload.items.filter(row => merged.has(row.id))) {
      const owed = (deferred.files?.[String(entry.id)] ?? []).filter(file => existsSync(join(context.root, file)));
      if (owed.length) parts.push(['proof', phaseOf('proof', prove({ runner: deferred.runner, files: owed, ledger: null }, { env, waivers: Array.isArray(payload.waivers) ? payload.waivers : [], deadline })), deferred.runner]);
    }
    // Affected tests no submit proved (contracts main gained since, deferred journeys) run on the tree being checked [C7,#7378].
    const contractPart = payload.contracts ? (await import('./contracts.js')).contractCheck(payload, env) : null;
    if (contractPart) parts.push(['proof', phaseOf('contracts', contractPart), payload.contracts.runner]);
    let proof = null, waived = null, contracts = null, rerun = null;
    for (const [role, part, runner] of parts) {
      let result = await part(context);
      // landing.retryRedsOnce: a proof red in one to three files runs those files once more on this same tree; green on the rerun makes the part green [C7,#11744].
      if (payload.retryRedsOnce === true && role === 'proof' && typeof runner === 'string' && !result?.ok && !result?.timeout && result?.failures?.length) {
        const again = await rerunProofRed(result.failures, runner, context, { env, payload, deadline });
        if (again && !again.length) { rerun = { files: [...new Set(result.failures.map(row => row.file))], green: true }; result = { ...result, ok: true, detail: null }; }
      }
      if (result?.proof) proof = result.proof;
      if (result?.contracts) contracts = result.contracts;
      if (result?.waived?.length) waived = result.waived;
      if (!result?.ok) return { ok: false, detail: result?.detail ?? 'the landing check failed', role, ...(result?.timeout ? { timeout: true } : {}), ...(result?.guard ? { guard: result.guard } : {}), ...(typeof result?.output === 'string' ? { output: result.output } : {}), ...(result?.failed ? { failed: result.failed } : {}), ...(proof ? { proof } : {}), ...(contracts ? { contracts } : {}) };
    }
    return { ok: true, detail: null, ...(waived ? { waived } : {}), ...(proof ? { proof } : {}), ...(contracts ? { contracts } : {}), ...(rerun ? { rerun } : {}) };
  };
}

/**
 * Rerun a proof red's failing files once on the merged tree being checked, with the part's own runner.
 * Why: rerunRedOnce decides which reds are worth a rerun; this only runs the files and reads their failures back [C7,#11744].
 *
 * @returns {Promise<{ file: string, name: string }[] | null>} The failures that remain, [] when green, null when the rerun cannot say.
 */
async function rerunProofRed(failures, runner, context, { env, payload, deadline }) {
  const { rerunRedOnce } = await import('./contracts.js');
  const { ledgerProofCheck } = await import('./proof.js');
  return rerunRedOnce(failures, { rerun: async files => {
    const result = await ledgerProofCheck({ runner, files, ledger: null }, { env, waivers: Array.isArray(payload.waivers) ? payload.waivers : [], deadline })(context);
    return result.ok ? [] : result.timeout ? null : result.failures ?? null;
  } });
}

/**
 * Run a landing check under landing.stallStop: the check reports progress (`context.progress()`, as a command does for each
 * byte it prints, and each lease renewal counts), and two minutes (LANDING_STALL_MS) on `clock` without any stops it. The check's process tree is stopped
 * through `context.signal`, and the result is a timeout carrying landingStallDescription, which the board offers again
 * rather than returning the items as a red [C7,#8749].
 */
async function stallWatched(check, context, { clock, pollMs }) {
  let last = clock();
  const progress = () => { last = clock(); };
  const stop = new AbortController();
  let timer = null;
  const stalled = new Promise(resolve => {
    // Each look re-arms the next: a watch that ends with the check, not a loop that outlives it.
    const look = () => {
      if (!landingStallExpired(last, clock(), LANDING_STALL_MS)) { timer = setTimeout(look, pollMs); return; }
      const detail = `${LAND_PROOF_TIMEOUT}: ${landingStallDescription({ id: `land:${context.items.join(',')}`, state: 'checking' }, 'check')}`;
      // Settle first: a check that answers the abort must not outrun the stall result.
      resolve({ ok: false, timeout: true, detail });
      stop.abort();
    };
    timer = setTimeout(look, pollMs);
  });
  try { return await Promise.race([check({ ...context, progress, signal: stop.signal, renew: async () => { progress(); return context.renew(); } }), stalled]); } finally { clearTimeout(timer); }
}

/**
 * Land one item onto HEAD; null when it landed, else why not, with the merge aborted.
 * Off (the default) it is the --no-ff merge. With `squash` (landing.squash) it is one single-parent commit through
 * squashOnto, with the same message, and HEAD moves to it. Why: main keeps one commit per item, and the branch stays
 * under refs/pullboard/items/<id> for audit [C7,#9219].
 */
function mergeItem(root, entry, base, squash = false, union = false) {
  if (squash) return squashItem(root, entry, base);
  const merged = tryGit(root, landingMergeArgs(root, entry));
  if (merged.status === 0) return null;
  // payload.unionRegistries: a stop on cell test-registry conflicts alone is two items adding records, so union them and land [C7,U148].
  if (union && commitUnionedMerge(root)) return null;
  tryGit(root, ['merge', '--abort']);
  return `#${entry.id} does not merge on ${base.slice(0, 12)}: ${(merged.stdout || merged.stderr).slice(0, 240)}`;
}

/** The squash path of mergeItem: the offered header and trailers (or the merge fallback subject) as the one commit's message. */
function squashItem(root, entry, base) {
  const message = typeof entry.header === 'string' && typeof entry.trailers === 'string'
    ? `${entry.header}\n\n${entry.trailers}` : `Merge #${entry.id} onto main [${citedIds(root, entry.commit)}]`;
  const head = must(root, ['rev-parse', 'HEAD']);
  const squashed = squashOnto(root, { base: head, tip: entry.commit, message, item: entry.id });
  if (squashed.conflict) return `#${entry.id} does not merge on ${base.slice(0, 12)}: conflict in ${squashed.files.join(', ').slice(0, 240)}`;
  must(root, ['reset', '-q', '--hard', squashed.commit]);
  return null;
}

/**
 * Number the merged tree's unlanded engines and refresh its format table and generated docs, amended into the last
 * merge; null when done, else why not. Why: the job is the only lander, so it must derive what the batch path did, or
 * main keeps unassignedEngine() placeholders (#1101, #6951) [C7].
 */
async function deriveMerged(root, { base, badges }) {
  try { await amendLandingEngines(root, IDENTITY); await amendLandingRegistries(root, { base, badges, hooks: IDENTITY }); return null; } catch (error) {
    must(root, ['reset', '-q', '--hard', 'HEAD']);
    return `the landing derive failed: ${String(error?.message ?? error).slice(0, 300)}`;
  }
}

/**
 * Find which merged items turn the check red: merge them again one at a time on the base, checking each step, and drop
 * each one whose merge turns it red; each red item keeps its own failure, so a sibling's red never names another item's files. HEAD ends on the base plus the clean items, a tree the last step checked green.
 * Why: 0.9.3's landing returned only the red item; the clean ones beside it stay accepted, or land under separate publish.
 */
async function isolateReds(root, { base, trunk, pending, check, renew, payload }) {
  must(root, ['checkout', '-q', '--detach', '--force', base]);
  must(root, ['clean', '-q', '-fd']);
  const kept = [], red = [], guards = new Map(), details = new Map();
  let detail = null;
  for (const entry of pending) {
    const before = must(root, ['rev-parse', 'HEAD']);
    if (mergeItem(root, entry, base, payload.squash === true, payload.unionRegistries === true)) { red.push(entry.id); continue; }
    if (!await renew()) return null;
    const derived = await deriveMerged(root, { base, badges: payload.badges });
    admitTrunk(root, { trunk, base });
    const result = derived ? { ok: false, detail: derived } : await check({ root, base, items: [...kept, entry.id], renew });
    if (result?.timeout) return { timeout: result.detail };
    if (result?.ok) { kept.push(entry.id); continue; }
    red.push(entry.id);
    if (result?.guard) guards.set(entry.id, result.guard);
    details.set(entry.id, `#${entry.id}: ${result?.detail ?? 'the landing check failed'}`);
    detail ??= details.get(entry.id);
    must(root, ['reset', '-q', '--hard', before]);
    must(root, ['clean', '-q', '-fd']);
  }
  return { kept, red, detail, details, guards };
}

/**
 * Each landed item's first-containing merge on the first-parent path from base to tip, by item id. Why: the board
 * records each item at its own merge, as the Mac engine did, not every item at the batch tip [B3,R3,#7506].
 */
function firstMerges(root, base, tip, pending, squash = false) {
  const merges = {};
  const path = must(root, ['rev-list', '--reverse', '--first-parent', `${base}..${tip}`]).split('\n').filter(Boolean);
  // A squashed item is not an ancestor of its commit; the commits follow the order the items were squashed in [C7,#9219].
  if (squash && path.length === pending.length) { pending.forEach((entry, index) => { merges[entry.id] = path[index]; }); return merges; }
  for (const merge of path) {
    for (const entry of pending) if (!merges[entry.id] && tryGit(root, ['merge-base', '--is-ancestor', entry.commit, merge]).status === 0) merges[entry.id] = merge;
  }
  return merges;
}

/**
 * Land one job's accepted items on the trunk remote, from a runner. Each attempt fetches trunk, skips items trunk
 * already holds, merges the rest on that tip with --no-ff, numbers new engines into the last merge, runs the check on the merged tree, and pushes with
 * --force-with-lease=<trunk>:<the tip it merged on>: git's compare-and-swap, so the push lands only if trunk is still
 * exactly that tip. A push that finds trunk moved starts again on the new tip, so a landing never publishes a tree it
 * did not check, never lands on a stale base, and never overwrites a rival's landing.
 *
 * @param {{ remote: string, trunk: string, expect: string, items: { id: number, commit: string, ref?: string, header?: string, trailers?: string }[], check?: string[], checks?: Record<string, string>, checkout?: boolean, upstream?: string, publish?: string, proof?: object, waivers?: object[] }} payload - checks: each item's own check by id; checkout:
 *   the remote is the board host's checkout, whose checked-out trunk the push updates in place [P7]; upstream: that checkout's own remote, which then takes the
 *   landed tip fast-forward [#7398]; waivers: the person's live waivers the proof may honour [#655].
 * @param {{ workdir: string, checks?: (context: { root: string, base: string, items: number[], renew: () => Promise<boolean> | boolean }) => Promise<{ ok: boolean, detail?: string | null }> | { ok: boolean, detail?: string | null },
 *   renew?: () => boolean | Promise<boolean>, diagnose?: Function | null, attempts?: number, pushOptions?: () => string[], env?: NodeJS.ProcessEnv }} options - env: the proof's environment, a pulled job's so its ledger context key matches the gate's; pushOptions: the current lease's landing permit as git push options.
 * `diagnose` (from the runner's handler setup, since packages never import apps) reads a red's failing cases and pairs them: ({ root, base, output, role, flakes, head, tree }) => the receipt's `red` record, or null.
 * @returns {Promise<{ kind: string, outcome: 'landed' | 'conflict' | 'red' | 'item-moved' | 'trunk-busy' | 'install-red' | 'lease-lost' | 'push-failed' | 'proof-timeout',
 *   expect: string, base: string | null, trunk: string | null, landed: number[], already: number[], attempts: number, moved: string[], detail: string | null,
 *   returned: { id: number, reason: 'red' | 'conflict' | 'hook', detail: string }[] }>} returned: the items the board sends back to their builders, or parks
 *   under separate publish (payload.publish), as 0.9.3's landing did; a red outcome lands nothing.
 */
export async function runLandingJob(payload, { workdir, checks = null, renew = () => true, attempts = PUSH_ATTEMPTS, pushOptions = () => [], env = environment.all(), diagnose = null, shards = null, clock = Date.now, stallPollMs = 1000, asyncFetch = false }) {
  const { remote, trunk, expect, items } = payload;
  // asyncFetch (landing.asyncFetch, off by default; the runner's caller reads the setting): the fetches below run without blocking the event loop, so the lease renews while they work [C7,#9516].
  const fetchOne = (...args) => asyncFetch ? fetchItemAsync(...args) : fetchItem(...args);
  const fetchTip = (...args) => asyncFetch ? fetchTrunkAsync(...args) : fetchTrunk(...args);
  if (Number.isSafeInteger(payload.shape) && payload.shape > LANDING_PAYLOAD_SHAPE) {
    // A plain coded error: this cell takes no kernel import, and the runner releases the job with this message, which names the code.
    throw Object.assign(new Error(`[LANDING_PAYLOAD_VERSION] land job payload shape ${payload.shape} is newer than this runner's code (shape ${LANDING_PAYLOAD_SHAPE}); next: update this runner's pullboard checkout and restart it`), { name: 'Refused', code: 'LANDING_PAYLOAD_VERSION' });
  }
  // A job carrying a ledger proof runs only its misses on the merged tree; the module loads only then, off the worker bundle [P7].
  const phases = [];
  const check = checks ?? await landingCheck(payload, env, phases, shards && { ...shards, remote, pushOptions });
  const separate = payload.publish === 'separate';
  const root = landingCheckout(workdir);
  // phases: each timed landing phase in the order it ran (merge, static checks, cli smoke, push), as the batch landing said them [C7,B3].
  const receipt = { kind: LANDING_JOB_KIND, outcome: 'trunk-busy', expect, base: null, trunk: null, landed: [], already: [], attempts: 0, moved: [], detail: null, returned: [], phases };
  const done = (outcome, fields = {}) => Object.assign(receipt, { outcome }, fields);
  // guard: the static guard row a red came from; the board returns that item to its builder even under separate publish [#7492].
  const giveBack = (id, reason, detail, guard = null) => { receipt.returned.push({ id, reason, detail, ...(guard ? { guard } : {}) }); receipt.detail ??= detail; };
  // Renew before each synchronous fetch: git blocks this process's event loop, so the runner's background renewal cannot fire
  // while one runs, and a fetch pair longer than the 2-minute lease let five runners in a row claim #9180's job and drop it [C7,#9250].
  // 'fetch items' times the whole loop below (renews included), 'fetch trunk' each trunk fetch: the fetch loop is where a lease lapsed (land:9342) [C7,#9545].
  const fetchStart = Date.now();
  const fetchedAll = () => phases.push({ phase: 'fetch items', ms: Date.now() - fetchStart });
  for (const entry of items) {
    if (!await renew()) { fetchedAll(); return done('lease-lost', { detail: 'the job\'s lease moved to another runner while it fetched the accepted items' }); }
    const fetched = await fetchOne(root, remote, entry);
    if (fetched.moved) { fetchedAll(); return done('item-moved', { detail: `#${entry.id}: ${fetched.moved}` }); }
  }
  fetchedAll();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    receipt.attempts = attempt;
    if (!await renew()) return done('lease-lost', { detail: 'the job\'s lease moved to another runner before it fetched trunk' });
    const base = await timed(phases, 'fetch trunk', async () => fetchTip(root, remote, trunk));
    if (base !== (receipt.base ?? expect)) receipt.moved.push(base);
    receipt.base = base;
    const already = items.filter(entry => tryGit(root, ['merge-base', '--is-ancestor', entry.commit, base]).status === 0).map(entry => entry.id);
    receipt.already = already;
    // A returned item stays out of every later attempt: it goes back to its builder, or parks, whatever trunk does next.
    const waiting = items.filter(entry => !already.includes(entry.id) && !receipt.returned.some(row => row.id === entry.id));
    if (waiting.length === 0) return receipt.returned.length ? done(receipt.returned[0].reason, { trunk: base, landed: [] })
      : done('landed', { trunk: base, landed: [], ...publishUpstream(root, { payload, trunk, tip: base, options: pushOptions() }) });
    must(root, ['checkout', '-q', '--detach', '--force', base]);
    must(root, ['clean', '-q', '-fd']);
    // A sibling that collides goes back alone, as in 0.9.3: the items that merge cleanly still land [P7].
    const mergeStart = Date.now();
    const squash = payload.squash === true;
    let pending = waiting.filter(entry => {
      const collided = mergeItem(root, entry, base, squash, payload.unionRegistries === true);
      if (collided) giveBack(entry.id, 'conflict', collided);
      return !collided;
    });
    phases.push({ phase: 'merge', ms: Date.now() - mergeStart });
    if (pending.length === 0) return done('conflict');
    // Renew around the check: a check longer than the lease may let a second runner take the job, which is safe, since
    // the push's compare-and-swap and the on-trunk skip keep a duplicate landing from losing or doubling a commit.
    if (!await renew()) return done('lease-lost', { detail: 'the job\'s lease moved to another runner before its check' });
    // The check proves the tree that lands: engine numbers and derived docs ride inside the last merge [C7].
    const derived = await deriveMerged(root, { base, badges: payload.badges });
    admitTrunk(root, { trunk, base });
    const result = derived ? { ok: false, detail: derived } : payload.stallStop === true ? await stallWatched(check, { root, base, items: pending.map(entry => entry.id), renew }, { clock, pollMs: stallPollMs }) : await check({ root, base, items: pending.map(entry => entry.id), renew });
    if (result?.proof) receipt.proof = result.proof;
    if (result?.contracts) receipt.contracts = result.contracts;
    // landing.retryRedsOnce: the files a red proof reran once on this tree, green, so the receipt says why a red landed [C7,#11744].
    if (result?.ok && result.rerun) receipt.rerun = result.rerun;
    // A proof red only in tests the person waived lands waived, not green; the receipt names each waiver [#655].
    if (result?.ok && result.waived?.length) receipt.waived = result.waived;
    // A check that ran past its deadline is no red: nothing is returned to a builder, and the board offers the landing again [C7,#7820].
    if (result?.timeout) return done('proof-timeout', { detail: result.detail });
    // A red install names its command and returns no item: no item turned the tree red [C7,#12232].
    if (!result?.ok && result?.role === 'install') return done('install-red', { detail: result.detail });
    if (!result?.ok) {
      // The merged commit stays reachable under a ref per item, with the failing names and full-log path, until the item is resolved [#8499].
      const mergedTip = tryGit(root, ['rev-parse', 'HEAD']).stdout.trim();
      const refs = [];
      for (const entry of pending) if (mergedTip && tryGit(root, ['update-ref', `refs/pullboard/land-red/${entry.id}`, mergedTip]).status === 0) refs.push(`refs/pullboard/land-red/${entry.id}`);
      receipt.failed = { commit: mergedTip || null, refs, ...(result?.failed ?? {}) };
      // The red's failing cases, and their paired reruns when the offer turned reruns on, are read while the merged tree is still checked out [C7,H16].
      if (!receipt.red && typeof diagnose === 'function' && payload.flakes && typeof result?.output === 'string') {
        try { receipt.red = await diagnose({ root, base, output: result.output, role: result.role ?? 'check', flakes: payload.flakes, head: must(root, ['rev-parse', 'HEAD']), tree: must(root, ['rev-parse', 'HEAD^{tree}']) }); } catch { /* a diagnosis that cannot run leaves the red unrecorded, never changed */ }
      }
      // A red tree lands nothing it did not check green: name the red items, return them, and under separate publish
      // land the clean rest on the tree the culprit search checked green [P7].
      const found = pending.length > 1 ? await isolateReds(root, { base, trunk, pending, check, renew, payload })
        : { kept: [], red: [pending[0].id], detail: `#${pending[0].id}: ${result?.detail ?? 'the landing check failed'}`, guards: new Map(result?.guard ? [[pending[0].id, result.guard]] : []) };
      if (!found) return done('lease-lost', { detail: 'the job\'s lease moved to another runner during its culprit search' });
      if (found.timeout) return done('proof-timeout', { detail: found.timeout });
      receipt.detail ??= result?.detail ?? 'the landing check failed';
      for (const id of found.red) giveBack(id, 'red', found.red.length === 1 && found.detail ? found.detail : `#${id} turns the merged tree red: ${found.details?.get(id) ?? found.detail ?? result?.detail}`, found.guards?.get(id));
      // Per-item landing, the default, lands the clean rest as separate publish does; perItem false lands nothing red [C7,#2901].
      if (found.red.length && ((!separate && payload.perItem === false) || found.kept.length === 0)) return done('red');
      pending = pending.filter(entry => found.kept.includes(entry.id));
    }
    if (!await renew()) return done('lease-lost', { detail: 'the job\'s lease moved to another runner before the push' });
    const tip = must(root, ['rev-parse', 'HEAD']);
    const pushStart = Date.now();
    // With hops on the job (gate.fencedHop), a fence at a later epoch refuses HOP_FENCED here, before trunk is pushed [C7,#8437].
    const hopFence = Array.isArray(payload.hops) && payload.hops.length ? (await import('../step/publish.js')).hopFencePush(root, remote, payload.hops) : null;
    // A squash drops the item's commits from trunk's history, so the keep refs ride the same atomic push [C7,#9219].
    const keeps = squash ? pending.map(entry => `+${itemKeepRef(entry.id)}:${itemKeepRef(entry.id)}`) : [];
    const fence = keeps.length ? { leases: hopFence?.leases ?? [], refspecs: [...(hopFence?.refspecs ?? []), ...keeps], requireHeld: pushed => hopFence?.requireHeld(pushed) } : hopFence;
    const pushed = pushTrunk(root, { payload, trunk, base, remote, options: pushOptions(), fence });
    fence?.requireHeld(pushed);
    phases.push({ phase: 'push', ms: Date.now() - pushStart });
    if (pushed.status === 0) return done('landed', { trunk: tip, landed: pending.map(entry => entry.id), merges: firstMerges(root, base, tip, pending, squash), ...publishUpstream(root, { payload, trunk, tip, options: pushOptions() }) });
    // A refused push is a moved trunk only when trunk really moved; anything else is a push failure to report.
    if (await fetchTip(root, remote, trunk) === base) {
      // A trunk hook's refusal gives every pending item back with the hook's words, as a red does [C7,P7].
      const hook = hookRefusal(pushed);
      if (hook) {
        for (const entry of pending) giveBack(entry.id, 'hook', `the trunk hook refused the push: ${hook}`);
        return done('red');
      }
      return done('push-failed', { detail: pushFailedDetail(pushed, remote, trunk) });
    }
  }
  return done('trunk-busy', { detail: `trunk moved under each of ${attempts} attempts; offer the landing again` });
}

/**
 * Take one landing job from the board and run it: claim by kind, land, post the receipt. `call` is the board API's
 * job queue call (`{ action: 'claim' | 'renew' | 'receipt', ... }`), local or over HTTPS; this runner never opens
 * the board's database, and the board never runs a landing step.
 *
 * @param {{ call: (body: object) => object | Promise<object>, runner: string, capabilities?: string[], workdir: string,
 *   checks?: Parameters<typeof runLandingJob>[1]['checks'], env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ job: string, receipt: Awaited<ReturnType<typeof runLandingJob>>, recorded: boolean } | null>} null when no landing waits.
 */
export async function takeLandingJob({ call, runner, capabilities = [], workdir, checks = null, env = environment.all(), diagnose = null }) {
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
  // What a big job moved out of its payload (a large proof) is read back from the job's request, which only its holder reads [#7766].
  const moved = Array.isArray(claim.payload?.requested) && claim.payload.requested.length ? (await call({ action: 'request', job, runner, token }))?.request?.land : null;
  const landing = moved ? { ...claim.payload, ...moved } : claim.payload;
  // landing.shardProof: the holder offers its proof's files as shard jobs and reads their receipts back, through the board API like its renewals [C7,#7818].
  const shards = landing.shardProof ? { job, cores: availableParallelism(), offer: ({ merged, ref, plan, gate, reuse }) => call({ action: 'shards', job, runner, token, merged, ref, plan, gate, ...(reuse ? { reuseCommits: landing.items.map(entry => entry.commit) } : {}) }),
    receipts: async ids => (await call({ action: 'shardReceipts', job, runner, token, shards: ids })).shards } : null;
  const receipt = await runLandingJob(landing, { workdir, checks, renew, env, diagnose, shards, pushOptions: () => permit ? permitPushOptions(permit) : [] });
  try {
    const posted = await call({ action: 'receipt', job, runner, token, receipt });
    return { job, receipt, recorded: Boolean(posted.recorded) };
  } catch (error) {
    if (error?.code !== 'JOB_LEASE_MOVED') throw error;
    return { job, receipt, recorded: false };
  }
}
