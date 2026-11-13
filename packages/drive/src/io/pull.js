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
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
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
import { PROGRESS_ENV } from './progress.js';
import { watchProgress } from './progress.js';
import { PRUNE_INTERVAL_MS } from './prune.js';
import { pruneRunnerStores } from './prune.js';
import { pruneStaleSlots } from './prune.js';
import { checkoutCandidate } from '../../../pin/index.js';
export { checkoutCandidate };

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
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `trunk-${commit}.pack`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    return { file };
  };
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
  try { rmSync(folder, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a stale folder a writer still fills is the prune's; its home and tmp are made below */ }
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

/** How many test workers a pulled job may use: its share of the runner's cores, set by the serve that runs it [P7,#5919]. */
export const JOB_WORKERS_ENV = 'PULLBOARD_JOB_WORKERS';

/**
 * How many test workers a job of a serve may use: twice its even share of the runner's cores, at least 2, never more than its file count.
 * Why twice: tests mostly wait on spawned processes, git and timers, so an even share left a 10-core runner at 47% CPU while
 * 4-file jobs ran their files one after another for 640-1055 s (#5919 kept jobs from starving each other; this keeps that and fills idle cores).
 *
 * @param {number} slots - How many jobs the serve runs at once.
 * @param {number} [cores]
 * @param {number | null} [files] - How many test files the job runs, when known.
 * @returns {number}
 */
export function jobWorkers(slots, cores = availableParallelism(), files = null) {
  const share = Math.max(2, Math.ceil(2 * cores / Math.max(1, slots)));
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
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
      try { if (ours(readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0'))) pids.push(Number(entry)); } catch { /* gone or not ours */ }
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
 * @param {{ claim?: string | null, graceMs?: number, list?: (job: string, claim: string | null) => Promise<number[]>, pause?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<number[]>}
 */
export async function reapJob(job, group, { claim = null, graceMs = REAP_MS, list = jobProcesses, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const kill = (pid, name) => { try { process.kill(pid, name); } catch { /* already gone */ } };
  if (group) kill(-group, 'SIGTERM');
  const found = await list(job, claim);
  let left = found;
  for (const pid of left) kill(pid, 'SIGTERM');
  for (const until = Date.now() + graceMs; left.length && Date.now() < until;) { await pause(100); left = await list(job, claim); }
  if (group) kill(-group, 'SIGKILL');
  for (const pid of left) kill(pid, 'SIGKILL');
  for (let tries = 0; left.length && tries < 20; tries += 1) { await pause(50); left = await list(job, claim); }
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
 * @param {{ load: number, cores: number, share: number, running?: number }} machine - running: jobs this runner holds now; default 1.
 */
export function localLoadAdmits({ load, cores, share, running = 1 }) {
  return running === 0 || load < share * cores;
}

/**
 * Serve jobs from one board until the signal aborts, or after one job with `once`.
 * Why `once` never waits: a sandboxed runner starts, takes at most one job, and is thrown away, so an empty queue ends it.
 *
 * @param {object} options
 * @param {string} options.board - The board's API URL.
 * @param {string} [options.key] - The board key, when the URL carries none.
 * @param {string} [options.runner] - This runner's id; default the host name plus a random suffix.
 * @param {string[]} [options.capabilities] - What this runner can run; default hostCapabilities().
 * @param {string} [options.cache] - Where fetched history and checkouts live; default ~/.pullboard-runner/pull.
 * @param {boolean} [options.once] - Return after one job (posted or released), or at once when the queue is empty.
 * @param {number | string} [options.jobs] - How many jobs run at once; default PULLBOARD_RUNNER_JOBS, else serveSlots().
 * @param {number} [options.cores] - This runner's cores, shared out between its jobs; default availableParallelism().
 * @param {AbortSignal} [options.signal]
 * @param {(state: { running: number }) => boolean} [options.admit] - Asked before each claim, with the jobs it holds now; false leaves the queue untouched and tries again after the idle wait.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(line: string) => void} [options.say]
 * @param {string} [options.unreachableHint] - Logged once a streak of network failures reaches HINT_AFTER: the likely
 *   cause on this host and its fix, so an installed service never retries silently.
 * @param {{ renewMs?: number, renewRetryMs?: number, leaseMs?: number, idleMs?: number, firstMs?: number, maxMs?: number, ceilingMs?: number, reapMs?: number, progressMs?: number }} [options.timing] - progressMs: how often a run's test progress is posted.
 * @param {Record<string, (claim: object, tools: { cache: string, renew: () => Promise<boolean>, env: Record<string, string> }) => Promise<object>>} [options.handlers] - Jobs
 *   of these kinds run in this process instead of as an argv: a landing merges and pushes trunk itself. The handler's
 *   result is the receipt; renew extends the lease and reads false once another runner holds the job. Its cache is the
 *   slot's own folder, the serve's cache for slot 0.
 * @param {(commit: string) => Promise<{ file: string } | null>} [options.trunkPack] - Where a cold cache takes a shared
 *   trunk pack; default the board's, boardTrunkPack.
 * @param {(folder: string) => void} [options.removeFolder] - Removes a finished job's environment folder; a failure is said and left to the prune, never a stopped serve.
 * @returns {Promise<{ jobs: Array<{ job: string, outcome: 'posted' | 'released' | 'lost', receipt?: object }>, waits: number[], slots: number }>}
 */
export async function serveRunner({ board, key, runner, capabilities = hostCapabilities(), cache = join(homedir(), '.pullboard-runner', 'pull'),
  once = false, jobs: jobsSetting = process.env.PULLBOARD_RUNNER_JOBS, cores = availableParallelism(), signal, admit = () => true, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), say = () => {}, timing = {}, handlers = {}, trunkPack, unreachableHint, removeFolder = folder => rmSync(folder, { recursive: true, force: true, maxRetries: 3 }) }) {
  const endpoint = boardEndpoint(board, key);
  const pack = trunkPack ?? boardTrunkPack(endpoint, fetchImpl, join(cache, 'packs'));
  const id = runner ?? `${hostname().replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40) || 'runner'}-${randomBytes(3).toString('hex')}`;
  const { renewMs = RENEW_MS, renewRetryMs = RENEW_RETRY_MS, leaseMs = LEASE_MS, idleMs = IDLE_MS, firstMs = BACKOFF.firstMs, maxMs = BACKOFF.maxMs, ceilingMs = CEILING_MS, reapMs = REAP_MS } = timing;
  const slots = once ? 1 : serveSlots(jobsSetting, cores);
  // One checkout folder per slot, reset for each job it runs, since a fresh one cost 14 s per job (#5812) [P7].
  const jobs = [], waits = [], folders = `runner-${id.replace(/[^A-Za-z0-9._-]/gu, '-')}`;
  let delay = firstMs;
  // Job environment folders a running job owns, which a prune never removes.
  const liveEnvironments = new Set();
  let prunedAt = 0;
  // Earlier serves' slot folders are dead once this one starts, so they go before the first job [P7].
  try { const gone = await pruneStaleSlots({ cache, instance: folders }); if (gone.length) say(`removed ${gone.length} stale slot folder(s)`); } catch { /* Pruning is best effort. */ }
  /** Prune old results and dead environment folders at most once an interval; a failure never stops serving. */
  const prune = () => {
    if (Date.now() - prunedAt < PRUNE_INTERVAL_MS) return;
    prunedAt = Date.now();
    try { const done = pruneRunnerStores({ root: dirname(cache), cache, live: liveEnvironments }); if (done.removed.length) say(`pruned ${done.removed.length} old folder(s)`); } catch { /* Pruning is best effort. */ }
  };
  /** Wait out an unreachable board, longer each time in a row, and note the wait. */
  let failures = 0;
  const backoff = async error => {
    say(`${error.message}; retrying in ${delay} ms`);
    // A board no request reaches, again and again, is likely blocked on this host: say once per streak what to fix.
    failures = error.network ? failures + 1 : 0;
    if (unreachableHint && failures === HINT_AFTER) say(`board still unreachable after ${failures} tries; likely cause: ${unreachableHint}`);
    waits.push(delay); await sleep(delay); delay = Math.min(delay * 2, maxMs);
  };
  /** Call the board until it answers; only the board's own refusal ends the call. */
  const reliably = async body => {
    for (;;) {
      if (signal?.aborted) throw new Refused('RUNNER_STOPPED', 'the runner was stopped');
      try { const answer = await queueCall(endpoint, body, fetchImpl); delay = firstMs; failures = 0; return answer; }
      catch (error) { if (!(error instanceof BoardUnreachable)) throw error; await backoff(error); }
    }
  };
  /** Run a handled kind in this process and post its result as the receipt; a lost lease posts nothing. */
  const handled = async (claim, held, workCache, name) => {
    const renew = async () => {
      try { return (await queueCall(endpoint, { action: 'renew', ...held }, fetchImpl)).renewed !== false; }
      catch (error) { return error instanceof BoardUnreachable; }
    };
    let receipt;
    // A land job's proof runs under the same environment a gate job does, so its ledger context key matches the gate's [P7].
    liveEnvironments.add(name);
    try { receipt = await handlers[claim.kind](claim, { cache: workCache, renew, env: jobEnvironment(cache, name, claim.job).env }); }
    catch (error) {
      // A handler that could not run (a fetch, a full disk) is an infrastructure wait: hand the job back, never a red receipt.
      say(`releasing ${claim.job}: ${error?.message ?? error}`);
      await reliably({ action: 'release', ...held, reason: String(error?.message ?? error) }).catch(refusal => { if (refusal.code !== 'JOB_LEASE_MOVED') throw refusal; });
      return { outcome: 'released' };
    } finally { liveEnvironments.delete(name); }
    try {
      await reliably({ action: 'receipt', ...held, receipt });
      say(`posted ${claim.job}: ${receipt?.outcome ?? 'done'}`);
      return { outcome: 'posted', receipt };
    } catch (error) {
      if (error.code !== 'JOB_LEASE_MOVED' && error.code !== 'RUNNER_STOPPED') throw error;
      return { outcome: 'lost' };
    }
  };
  /** Hand checkout work to the shared object cache one job at a time: concurrent fetches into one bare store race on its refs. */
  let cacheLock = Promise.resolve();
  const serially = work => { const turn = cacheLock.then(work, work); cacheLock = turn.catch(() => {}); return turn; };
  /**
   * Run one claimed job in its slot and say how it ended; null when the runner stopped before it held anything.
   * Why a slot: concurrent jobs each own a checkout and, for handled kinds, a working folder, so no two share files.
   */
  const runClaim = async (claim, trunk, slot) => {
    const held = { job: claim.job, runner: id, token: claim.token };
    say(`claimed ${claim.job} (attempt ${claim.attempt}) at ${claim.candidate} in slot ${slot}`);
    if (Object.hasOwn(handlers, claim.kind)) return { job: claim.job, ...await handled(claim, held, slot === 0 ? cache : join(cache, 'slot', String(slot)), `${folders}-${slot}`) };
    // Renew from the claim on, through the request and the fetch too: a fetch longer than the 2-minute lease let another
    // runner take the job mid-fetch, and every job churned from runner to runner unrun (#5805).
    let lost = false, onLost = () => {}, renewedAt = Date.now(), timer = null, ended = false;
    const lose = () => { lost = true; onLost(); };
    // A renewal the board never answered retries every few seconds, past the lease too: only the board's answer that
    // another runner holds the job stops it, since the board renews a lapsed lease no one claimed (#6546).
    const renewOnce = () => {
      if (ended || lost) return;
      queueCall(endpoint, { action: 'renew', ...held }, fetchImpl).then(renewed => {
        if (renewed.renewed === false) { lose(); return; }
        renewedAt = Date.now(); timer = setTimeout(renewOnce, renewMs);
      }, error => {
        if (error instanceof Refused && error.code === 'JOB_LEASE_MOVED') { lose(); return; }
        say(`renewal ${Date.now() - renewedAt >= leaseMs ? 'still failing past the lease' : 'skipped'}: ${error.message}`); timer = setTimeout(renewOnce, renewRetryMs);
      });
    };
    timer = setTimeout(renewOnce, renewMs);
    const renewer = { stop: () => { ended = true; clearTimeout(timer); } };
    try { return await runHeld(claim, trunk, slot, held, () => lost, stop => { onLost = stop; }); }
    finally { renewer.stop(); }
  };
  /** Fetch, run and report one claimed argv job while runClaim renews its lease; isLost reads whether the lease moved. */
  const runHeld = async (claim, trunk, slot, held, isLost, whenLost) => {
    // A job offered with no run carries its argv and stdin in its request, which only the claim's holder reads [P7].
    let run = claim.run ?? [], input = null, also = claim.base ? [claim.base] : [], named = null;
    if (!run.length) {
      let asked;
      try { asked = await reliably({ action: 'request', ...held }); }
      catch (error) { if (error.code === 'RUNNER_STOPPED') return null; if (error.code === 'JOB_LEASE_MOVED') return { job: claim.job, outcome: 'lost' }; throw error; }
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
    const name = `${claim.job.replace(/[^A-Za-z0-9._-]/gu, '-')}-${claim.attempt}`;
    // Each slot reuses its own folder: concurrent jobs never share one, and the shared object store fetches one at a time.
    const checkout = await serially(() => checkoutCandidate(cache, trunk, claim.candidate, `${folders}-${slot}`, also, { main: claim.base ?? null, pack }));
    if (!checkout.ok || !run.length) {
      // A candidate this runner cannot fetch is an infrastructure wait: hand the job back, never a red receipt.
      const reason = checkout.ok ? 'the job names nothing to run' : checkout.reason; say(`releasing ${claim.job}: ${reason}`);
      await reliably({ action: 'release', ...held, reason }).catch(error => { if (error.code !== 'JOB_LEASE_MOVED') throw error; });
      return { job: claim.job, outcome: 'released' };
    }
    if (isLost()) { say(`lost the lease on ${claim.job} while fetching it`); return { job: claim.job, outcome: 'lost' }; }
    const started = Date.now();
    liveEnvironments.add(name);
    const job = jobEnvironment(cache, name, claim.job), tag = randomBytes(8).toString('hex');
    // The job's full output stays on this runner by job id; the receipt says where, beside its digest [P7].
    const kept = keepFolder(cache, claim.job, claim.attempt);
    // The run's test reporter appends each file's state to this file; it is posted as the job's progress step, lease-checked like the receipt (#5823).
    const progressFile = join(cache, 'progress', `${name}.jsonl`);
    mkdirSync(join(cache, 'progress'), { recursive: true }); rmSync(progressFile, { force: true });
    const progress = watchProgress({ file: progressFile, selected: named, everyMs: timing.progressMs,
      post: body => queueCall(endpoint, { action: 'progress', ...held, progress: body }, fetchImpl) });
    // The job fetches any further commit it needs, such as a claim base on another item's branch, from this same trunk remote (#5808).
    // The gate bootstrap judges a project whose main is not Pullboard's tree with this runner's own install (#6265).
    const env = { ...job.env, PULLBOARD_RUNNER_TOOLS: fileURLToPath(new URL('../../../../', import.meta.url)), [RUNNER_CLAIM_ENV]: tag, [JOB_WORKERS_ENV]: String(jobWorkers(slots, cores, named)), PULLBOARD_TRUNK_REMOTE: trunk, [PROGRESS_ENV]: progressFile, ...(kept ? { [RUNNER_OUTPUT_ENV]: kept } : {}) };
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
    const survivors = await reapJob(claim.job, running.pid, { claim: tag, graceMs: reapMs });
    if (survivors.length) say(`killed ${survivors.length} leftover process(es) of ${claim.job}: ${survivors.join(' ')}`);
    await progress.stop(); rmSync(progressFile, { force: true });
    // A leftover writer still filling tmp failed this with ENOTEMPTY and stopped the whole serve, draining 10 slots (#6307).
    try { removeFolder(job.folder); } catch (error) { say(`left ${name}'s environment folder to the prune: ${error?.code ?? error}`); }
    liveEnvironments.delete(name);
    if (signal?.aborted && !lost) {
      await queueCall(endpoint, { action: 'release', ...held, reason: 'runner stopped', backoff: false }, fetchImpl).catch(() => { /* the lease lapses instead */ });
      return { job: claim.job, outcome: 'released' };
    }
    if (lost) { say(`lost the lease on ${claim.job}; another runner may hold it`); return { job: claim.job, outcome: 'lost' }; }
    const receipt = { ...(gate ? gateReceipt(result, claim.candidate, Date.now() - started)
      : { status: result.status, signal: result.signal, commit: claim.candidate, run, outputSha256: result.outputSha256,
        outputBytes: result.outputBytes, tail: result.tail, durationMs: Date.now() - started }), ...(kept ? { output: { runner: id, folder: kept } } : {}) };
    try {
      await reliably({ action: 'receipt', ...held, receipt });
      say(`posted ${claim.job}: exit ${result.status}${gate ? `, gate ${receipt.gate.green ? 'green' : 'red'}` : ''}`);
      return { job: claim.job, outcome: 'posted', receipt };
    } catch (error) {
      if (error.code !== 'JOB_LEASE_MOVED' && error.code !== 'RUNNER_STOPPED') throw error;
      return { job: claim.job, outcome: 'lost' };
    }
  };
  // Claim until every slot holds a job, then claim again as each one ends: one serve uses the whole runner [P7].
  const active = new Set(), free = Array.from({ length: slots }, (_, slot) => slot);
  let failure = null;
  const start = (claim, trunk) => {
    const slot = free.shift();
    const task = runClaim(claim, trunk, slot).then(entry => { if (entry) jobs.push(entry); }, error => { failure ??= error; })
      .finally(() => { active.delete(task); free.push(slot); free.sort((a, b) => a - b); });
    active.add(task);
    return task;
  };
  while (!signal?.aborted && !failure) {
    prune();
    if (active.size >= slots) { await Promise.race(active); continue; }
    if (!admit({ running: active.size })) {
      if (once) { say('not claiming: the machine is over its load share'); break; }
      await Promise.race([sleep(idleMs), ...active]); continue;
    }
    let answer;
    try { answer = await reliably({ action: 'claim', runner: id, capabilities, jobs: slots, cores, ram: totalmem() }); }
    catch (error) { if (error.code !== 'RUNNER_STOPPED') failure = error; break; }
    if (!answer.claim) {
      // A one-job runner, such as a sandbox or an ephemeral CI container, exits on an empty queue instead of idling [P7].
      if (once) { say('nothing to claim: the queue is empty'); break; }
      await Promise.race([sleep(idleMs), ...active]); continue;
    }
    const task = start(answer.claim, answer.trunk);
    if (once) { await task; break; }
  }
  await Promise.all(active);
  if (failure) throw failure;
  return { jobs, waits, slots };
}
