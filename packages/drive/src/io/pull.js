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
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { hostname } from 'node:os';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { childEnvironment } from '../../../kernel/light.js';
import { PROGRESS_ENV } from './progress.js';
import { watchProgress } from './progress.js';

// Budget: the lease the board grants is 2 minutes; renewing every 30 s survives three lost renewals in a row.
const RENEW_MS = 30_000;
// Budget: the first retry after a failed board call waits 1 s, doubling to at most a minute between tries.
const BACKOFF = { firstMs: 1_000, maxMs: 60_000 };
// Budget: an idle runner asks for work every 2 s, one small POST to the board.
const IDLE_MS = 2_000;
// Budget: a receipt carries the last 4 KiB of output; the full output stays on the runner with its digest in the receipt.
const TAIL_BYTES = 4096;
// Budget: one job runs at most an hour unless the caller sets its own ceiling.
const CEILING_MS = 3_600_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
/** The line a gate job prints its receipt on; apps/cli's submit writes the same prefix into the job it offers. */
export const GATE_RECEIPT = 'PULLBOARD_GATE_RECEIPT ';
// Budget: a gate receipt line stays under the board's 64 KiB receipt limit; a longer line is output, not a receipt.
const RECEIPT_LINE_BYTES = 60 * 1024;
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
  constructor(cause) { super(`board unreachable: ${cause?.message ?? cause}`); this.code = 'BOARD_UNREACHABLE'; }
}

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

/** Run a git command in a directory, without blocking the lease renewals; resolve its status and text. */
function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? error?.message ?? '').trim() });
    });
  });
}

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
async function fetchCommit(store, trunk, commit) {
  if (!SHA.test(String(commit ?? ''))) return `the job names no commit (${commit})`;
  if ((await git(store, ['cat-file', '-e', `${commit}^{commit}`])).status === 0) return null;
  if (typeof trunk !== 'string' || !trunk) return 'the board named no trunk remote';
  const byId = await git(store, ['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', '--', trunk, commit]);
  if (byId.status !== 0) {
    const heads = await git(store, ['fetch', '-q', '--no-tags', '--', trunk, '+refs/heads/*:refs/remotes/trunk/*']);
    if (heads.status !== 0) return heads.stderr || byId.stderr;
  }
  return (await git(store, ['cat-file', '-e', `${commit}^{commit}`])).status === 0 ? null : `trunk remote has no commit ${commit}`;
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
 * @param {{ main?: string | null }} [options] - main: the commit the primary's main branch names; default none.
 * @returns {Promise<{ ok: true, folder: string, primary: string, reused: boolean } | { ok: false, reason: string }>}
 */
export async function checkoutCandidate(cache, trunk, commit, name, also = [], { main = null } = {}) {
  if (!SHA.test(String(commit ?? ''))) return { ok: false, reason: `the job names no commit (${commit})` };
  if (typeof trunk !== 'string' || !trunk) return { ok: false, reason: 'the board named no trunk remote' };
  if (main !== null && !SHA.test(String(main))) return { ok: false, reason: `the job names no main commit (${main})` };
  const { store, reason } = await objectStore(cache);
  if (!store) return { ok: false, reason };
  for (const wanted of new Set([commit, ...also, ...(main ? [main] : [])])) {
    const missing = await fetchCommit(store, trunk, wanted);
    if (missing) return { ok: false, reason: missing };
  }
  const folder = join(cache, 'work', name), primary = join(cache, 'main', name);
  if (await resetCheckout({ folder, primary }, commit, main)) return { ok: true, folder, primary, reused: true };
  await dropCheckout(cache, { folder, primary });
  mkdirSync(primary, { recursive: true });
  for (const args of [['init', '-q'], ['symbolic-ref', 'HEAD', 'refs/heads/main'], ['config', 'gc.auto', '0']]) {
    const step = await git(primary, args);
    if (step.status !== 0) return { ok: false, reason: step.stderr };
  }
  writeFileSync(join(primary, '.git', 'objects', 'info', 'alternates'), `${join(store, 'objects')}\n`);
  if (!(await pinMain(primary, main))) return { ok: false, reason: `could not point main at ${main}` };
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

/** What a runner operator may hand every job beyond the runner-owned values: progress reporting and fixture markers. */
const PASSED_ENV = /^(?:PULLBOARD_TEST_PROGRESS|(?:PULLBOARD_)?FIXTURE_[A-Z0-9_]+)$/u;

/**
 * A pulled job's own environment and the folders it lives in: a per-job HOME and temp folder beside the checkout, and
 * PULLBOARD_RUNNER_JOB, as a pushed runner builds it. Why: a job that inherited the runner service's environment ran
 * with the host's real HOME, ~/.pullboard and shared temp folder, and its proof failed where the controller's passed.
 *
 * @param {string} cache
 * @param {string} name - The job's checkout name.
 * @param {string} job - The job id, carried as PULLBOARD_RUNNER_JOB.
 * @param {NodeJS.ProcessEnv} [host] - The runner service's environment, read for PATH and the passed names only.
 * @returns {{ env: Record<string, string>, folder: string }}
 */
export function jobEnvironment(cache, name, job, host = process.env) {
  const folder = join(cache, 'env', name), home = join(folder, 'home'), temporary = join(folder, 'tmp');
  rmSync(folder, { recursive: true, force: true });
  for (const path of [home, temporary]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const safePath = [dirname(process.execPath), host.PATH || '/usr/local/bin:/usr/bin:/bin'].join(delimiter);
  const passed = Object.fromEntries(Object.entries(host).filter(([key, value]) => PASSED_ENV.test(key) && typeof value === 'string'));
  return { env: { ...passed, ...childEnvironment({ safePath, workerId: job }, home, temporary) }, folder };
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
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const old = readdirSync(parent).map(name => ({ name, at: statSync(join(parent, name)).mtimeMs })).sort((a, b) => b.at - a.at).slice(KEPT_JOBS);
    for (const { name } of old) rmSync(join(parent, name), { recursive: true, force: true });
    return folder;
  } catch { return null; }
}

/**
 * Run a job's argv in its checkout, in its own process group so a lost lease or the ceiling stops all of it. `input`,
 * when given, is written to its stdin. The last stdout line starting with `receiptLine` is kept whole, apart from the
 * output tail, so a receipt longer than the tail still reaches the board.
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @param {{ ceilingMs?: number, env?: NodeJS.ProcessEnv, input?: string | null, receiptLine?: string | null, keep?: string | null }} [options] - keep:
 *   a file the stream's first 8 MiB is copied to.
 * @returns {{ done: Promise<{ status: number | null, signal: string | null, outputSha256: string, outputBytes: number, tail: string, line: string | null }>, stop: () => void }}
 */
export function runJob(argv, cwd, { ceilingMs = CEILING_MS, env = process.env, input = null, receiptLine = null, keep = null } = {}) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const digest = createHash('sha256');
  let bytes = 0, tail = Buffer.alloc(0), partial = '', line = null;
  const take = chunk => {
    // The kept copy is the stream's first KEPT_JOB_BYTES; the receipt's tail carries its end.
    if (keep && bytes < KEPT_JOB_BYTES) { try { appendFileSync(keep, chunk.subarray(0, KEPT_JOB_BYTES - bytes), { mode: 0o600 }); } catch { keep = null; } }
    digest.update(chunk); bytes += chunk.length;
    tail = Buffer.concat([tail, chunk]); if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
  };
  /** Keep the newest whole stdout line that starts with the receipt prefix; longer than a receipt may be is not one. */
  const scan = chunk => {
    if (receiptLine === null) return;
    const rows = (partial + chunk.toString('utf8')).split('\n');
    partial = rows.pop();
    if (partial.length > RECEIPT_LINE_BYTES) partial = '';
    for (const row of rows) if (row.startsWith(receiptLine)) line = row;
  };
  child.stdout.on('data', chunk => { take(chunk); scan(chunk); }); child.stderr.on('data', take);
  if (input !== null) { child.stdin.on('error', () => { /* a job that exits before reading its input is judged by its exit */ }); child.stdin.end(input); }
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  const ceiling = setTimeout(stop, ceilingMs);
  const done = new Promise(resolve => {
    child.on('error', error => { take(Buffer.from(String(error.message))); });
    child.on('close', (status, signal) => {
      clearTimeout(ceiling);
      if (receiptLine !== null && partial.startsWith(receiptLine)) line = partial;
      resolve({ status, signal, outputSha256: digest.digest('hex'), outputBytes: bytes, tail: tail.toString('utf8'), line });
    });
  });
  return { done, stop };
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
 * Serve jobs from one board until the signal aborts, or after one job with `once`.
 *
 * @param {object} options
 * @param {string} options.board - The board's API URL.
 * @param {string} [options.key] - The board key, when the URL carries none.
 * @param {string} [options.runner] - This runner's id; default the host name plus a random suffix.
 * @param {string[]} [options.capabilities] - What this runner can run; default hostCapabilities().
 * @param {string} [options.cache] - Where fetched history and checkouts live; default ~/.pullboard-runner/pull.
 * @param {boolean} [options.once] - Return after one job (posted or released).
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(line: string) => void} [options.say]
 * @param {{ renewMs?: number, idleMs?: number, firstMs?: number, maxMs?: number, ceilingMs?: number, progressMs?: number }} [options.timing] - progressMs: how often a run's test progress is posted.
 * @param {Record<string, (claim: object, tools: { cache: string, renew: () => Promise<boolean> }) => Promise<object>>} [options.handlers] - Jobs
 *   of these kinds run in this process instead of as an argv: a landing merges and pushes trunk itself. The handler's
 *   result is the receipt; renew extends the lease and reads false once another runner holds the job.
 * @returns {Promise<{ jobs: Array<{ job: string, outcome: 'posted' | 'released' | 'lost', receipt?: object }>, waits: number[] }>}
 */
export async function serveRunner({ board, key, runner, capabilities = hostCapabilities(), cache = join(homedir(), '.pullboard-runner', 'pull'),
  once = false, signal, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), say = () => {}, timing = {}, handlers = {} }) {
  const endpoint = boardEndpoint(board, key);
  const id = runner ?? `${hostname().replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40) || 'runner'}-${randomBytes(3).toString('hex')}`;
  const { renewMs = RENEW_MS, idleMs = IDLE_MS, firstMs = BACKOFF.firstMs, maxMs = BACKOFF.maxMs, ceilingMs = CEILING_MS } = timing;
  const jobs = [], waits = [], slot = `runner-${id.replace(/[^A-Za-z0-9._-]/gu, '-')}`;
  let delay = firstMs;
  /** Wait out an unreachable board, longer each time in a row, and note the wait. */
  const backoff = async error => { say(`${error.message}; retrying in ${delay} ms`); waits.push(delay); await sleep(delay); delay = Math.min(delay * 2, maxMs); };
  /** Call the board until it answers; only the board's own refusal ends the call. */
  const reliably = async body => {
    for (;;) {
      if (signal?.aborted) throw new Refused('RUNNER_STOPPED', 'the runner was stopped');
      try { const answer = await queueCall(endpoint, body, fetchImpl); delay = firstMs; return answer; }
      catch (error) { if (!(error instanceof BoardUnreachable)) throw error; await backoff(error); }
    }
  };
  /** Run a handled kind in this process and post its result as the receipt; a lost lease posts nothing. */
  const handled = async (claim, held) => {
    const renew = async () => {
      try { return (await queueCall(endpoint, { action: 'renew', ...held }, fetchImpl)).renewed !== false; }
      catch (error) { return error instanceof BoardUnreachable; }
    };
    let receipt;
    try { receipt = await handlers[claim.kind](claim, { cache, renew }); }
    catch (error) {
      // A handler that could not run (a fetch, a full disk) is an infrastructure wait: hand the job back, never a red receipt.
      say(`releasing ${claim.job}: ${error?.message ?? error}`);
      await reliably({ action: 'release', ...held }).catch(refusal => { if (refusal.code !== 'JOB_LEASE_MOVED') throw refusal; });
      return { outcome: 'released' };
    }
    try {
      await reliably({ action: 'receipt', ...held, receipt });
      say(`posted ${claim.job}: ${receipt?.outcome ?? 'done'}`);
      return { outcome: 'posted', receipt };
    } catch (error) {
      if (error.code !== 'JOB_LEASE_MOVED' && error.code !== 'RUNNER_STOPPED') throw error;
      return { outcome: 'lost' };
    }
  };
  while (!signal?.aborted) {
    let answer;
    try { answer = await reliably({ action: 'claim', runner: id, capabilities }); }
    catch (error) { if (error.code === 'RUNNER_STOPPED') break; throw error; }
    const claim = answer.claim;
    if (!claim) { await sleep(idleMs); continue; }
    const held = { job: claim.job, runner: id, token: claim.token };
    say(`claimed ${claim.job} (attempt ${claim.attempt}) at ${claim.candidate}`);
    if (Object.hasOwn(handlers, claim.kind)) {
      const outcome = await handled(claim, held);
      jobs.push({ job: claim.job, ...outcome });
      if (once) break;
      continue;
    }
    // A job offered with no run carries its argv and stdin in its request, which only the claim's holder reads [P7].
    let run = claim.run ?? [], input = null, also = claim.base ? [claim.base] : [], named = null;
    if (!run.length) {
      let asked;
      try { asked = await reliably({ action: 'request', ...held }); }
      catch (error) { if (error.code === 'RUNNER_STOPPED') break; if (error.code === 'JOB_LEASE_MOVED') { jobs.push({ job: claim.job, outcome: 'lost' }); if (once) break; continue; } throw error; }
      const request = asked?.request;
      if (Array.isArray(request?.run) && request.run.length) {
        run = request.run;
        input = JSON.stringify(request.input ?? null);
        named = Array.isArray(request.input?.data?.files) ? request.input.data.files.length : null;
        also = [...new Set([...also, ...(Array.isArray(request.commits) ? request.commits : [])])];
      }
    }
    // A job whose request carries its input runs the gate bootstrap, a gate's or a pulled test's, and prints one receipt line [P7].
    const gate = input !== null;
    // One folder per runner, reset for each job, since a fresh one cost 14 s per job (#5812) [P7].
    const checkout = await checkoutCandidate(cache, answer.trunk, claim.candidate, slot, also, { main: claim.base ?? null });
    if (!checkout.ok || !run.length) {
      // A candidate this runner cannot fetch is an infrastructure wait: hand the job back, never a red receipt.
      say(`releasing ${claim.job}: ${checkout.ok ? 'the job names nothing to run' : checkout.reason}`);
      await reliably({ action: 'release', ...held }).catch(error => { if (error.code !== 'JOB_LEASE_MOVED') throw error; });
      jobs.push({ job: claim.job, outcome: 'released' });
      if (once) break;
      continue;
    }
    const started = Date.now();
    const job = jobEnvironment(cache, `${claim.job.replace(/[^A-Za-z0-9._-]/gu, '-')}-${claim.attempt}`, claim.job);
    // The job's full output stays on this runner by job id; the receipt says where, beside its digest [P7].
    const kept = keepFolder(cache, claim.job, claim.attempt);
    // The run's test reporter appends each file's state to this file; it is posted as the job's progress step, lease-checked like the receipt (#5823).
    const progressFile = join(cache, 'progress', `${claim.job.replace(/[^A-Za-z0-9._-]/gu, '-')}-${claim.attempt}.jsonl`);
    mkdirSync(join(cache, 'progress'), { recursive: true }); rmSync(progressFile, { force: true });
    const progress = watchProgress({ file: progressFile, selected: named, everyMs: timing.progressMs,
      post: body => queueCall(endpoint, { action: 'progress', ...held, progress: body }, fetchImpl) });
    // The job fetches any further commit it needs, such as a claim base on another item's branch, from this same trunk remote (#5808).
    const env = { ...job.env, PULLBOARD_TRUNK_REMOTE: answer.trunk, [PROGRESS_ENV]: progressFile, ...(kept ? { [RUNNER_OUTPUT_ENV]: kept } : {}) };
    const running = runJob(run[0] === 'node' ? [process.execPath, ...run.slice(1)] : run, checkout.folder, { ceilingMs, input, receiptLine: gate ? GATE_RECEIPT : null,
      env, keep: kept ? join(kept, 'job.log') : null });
    let lost = false;
    // Renew while the job runs. An unreachable board only skips a renewal; a moved lease stops the job.
    const renewer = setInterval(() => {
      queueCall(endpoint, { action: 'renew', ...held }, fetchImpl).then(renewed => {
        if (renewed.renewed === false) { lost = true; running.stop(); }
      }, error => {
        if (error instanceof BoardUnreachable) { say(`renewal skipped: ${error.message}`); return; }
        lost = true; running.stop();
      });
    }, renewMs);
    // A stopped runner stops its job and hands it back at once, so the next puller need not wait out the lease.
    const stopping = () => running.stop();
    signal?.addEventListener('abort', stopping, { once: true });
    const result = await running.done.finally(() => { clearInterval(renewer); signal?.removeEventListener('abort', stopping); });
    await progress.stop(); rmSync(progressFile, { force: true });
    rmSync(job.folder, { recursive: true, force: true });
    if (signal?.aborted && !lost) {
      await queueCall(endpoint, { action: 'release', ...held }, fetchImpl).catch(() => { /* the lease lapses instead */ });
      jobs.push({ job: claim.job, outcome: 'released' });
      break;
    }
    if (lost) { say(`lost the lease on ${claim.job}; another runner may hold it`); jobs.push({ job: claim.job, outcome: 'lost' }); if (once) break; continue; }
    const receipt = { ...(gate ? gateReceipt(result, claim.candidate, Date.now() - started)
      : { status: result.status, signal: result.signal, commit: claim.candidate, run, outputSha256: result.outputSha256,
        outputBytes: result.outputBytes, tail: result.tail, durationMs: Date.now() - started }), ...(kept ? { output: { runner: id, folder: kept } } : {}) };
    try {
      await reliably({ action: 'receipt', ...held, receipt });
      say(`posted ${claim.job}: exit ${result.status}${gate ? `, gate ${receipt.gate.green ? 'green' : 'red'}` : ''}`);
      jobs.push({ job: claim.job, outcome: 'posted', receipt });
    } catch (error) {
      if (error.code !== 'JOB_LEASE_MOVED' && error.code !== 'RUNNER_STOPPED') throw error;
      jobs.push({ job: claim.job, outcome: 'lost' });
    }
    if (once) break;
  }
  return { jobs, waits };
}
