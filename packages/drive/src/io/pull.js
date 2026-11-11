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
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';

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

/** A refusal by code, as the CLI reports it: what failed and what to do next. Kept local so this runner-side file stays free of other cells. */
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

/**
 * Fetch one commit from the trunk remote into the runner's cache and check it out in a fresh folder.
 * Why a fetch by id first: protocol v2 serves any reachable commit, so a runner takes only what the job names; a
 * remote that refuses that falls back to fetching its branches.
 *
 * @returns {Promise<{ ok: true, folder: string } | { ok: false, reason: string }>}
 */
export async function checkoutCandidate(cache, trunk, commit, name) {
  if (!SHA.test(String(commit ?? ''))) return { ok: false, reason: `the job names no commit (${commit})` };
  if (typeof trunk !== 'string' || !trunk) return { ok: false, reason: 'the board named no trunk remote' };
  const store = join(cache, 'git');
  if (!existsSync(join(store, 'HEAD'))) {
    mkdirSync(store, { recursive: true });
    const init = await git(store, ['init', '-q', '--bare']);
    if (init.status !== 0) return { ok: false, reason: init.stderr };
  }
  if ((await git(store, ['cat-file', '-e', `${commit}^{commit}`])).status !== 0) {
    const byId = await git(store, ['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', '--', trunk, commit]);
    if (byId.status !== 0) {
      const heads = await git(store, ['fetch', '-q', '--no-tags', '--', trunk, '+refs/heads/*:refs/remotes/trunk/*']);
      if (heads.status !== 0) return { ok: false, reason: heads.stderr || byId.stderr };
    }
    if ((await git(store, ['cat-file', '-e', `${commit}^{commit}`])).status !== 0) return { ok: false, reason: `trunk remote has no commit ${commit}` };
  }
  const folder = join(cache, 'work', name);
  rmSync(folder, { recursive: true, force: true });
  await git(store, ['worktree', 'prune']);
  const added = await git(store, ['worktree', 'add', '-q', '--detach', folder, commit]);
  return added.status === 0 ? { ok: true, folder } : { ok: false, reason: added.stderr };
}

/** Remove a job's checkout from the cache. */
async function dropCheckout(cache, folder) {
  rmSync(folder, { recursive: true, force: true });
  await git(join(cache, 'git'), ['worktree', 'prune']);
}

/**
 * Run a job's argv in its checkout, in its own process group so a lost lease or the ceiling stops all of it.
 *
 * @returns {{ done: Promise<{ status: number | null, signal: string | null, outputSha256: string, outputBytes: number, tail: string }>, stop: () => void }}
 */
export function runJob(argv, cwd, { ceilingMs = CEILING_MS, env = process.env } = {}) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const digest = createHash('sha256');
  let bytes = 0, tail = Buffer.alloc(0);
  const take = chunk => {
    digest.update(chunk); bytes += chunk.length;
    tail = Buffer.concat([tail, chunk]); if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
  };
  child.stdout.on('data', take); child.stderr.on('data', take);
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  const ceiling = setTimeout(stop, ceilingMs);
  const done = new Promise(resolve => {
    child.on('error', error => { take(Buffer.from(String(error.message))); });
    child.on('close', (status, signal) => {
      clearTimeout(ceiling);
      resolve({ status, signal, outputSha256: digest.digest('hex'), outputBytes: bytes, tail: tail.toString('utf8') });
    });
  });
  return { done, stop };
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
 * @param {{ renewMs?: number, idleMs?: number, firstMs?: number, maxMs?: number, ceilingMs?: number }} [options.timing]
 * @returns {Promise<{ jobs: Array<{ job: string, outcome: 'posted' | 'released' | 'lost', receipt?: object }>, waits: number[] }>}
 */
export async function serveRunner({ board, key, runner, capabilities = hostCapabilities(), cache = join(homedir(), '.pullboard-runner', 'pull'),
  once = false, signal, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), say = () => {}, timing = {} }) {
  const endpoint = boardEndpoint(board, key);
  const id = runner ?? `${hostname().replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40) || 'runner'}-${randomBytes(3).toString('hex')}`;
  const { renewMs = RENEW_MS, idleMs = IDLE_MS, firstMs = BACKOFF.firstMs, maxMs = BACKOFF.maxMs, ceilingMs = CEILING_MS } = timing;
  const jobs = [], waits = [];
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
  while (!signal?.aborted) {
    let answer;
    try { answer = await reliably({ action: 'claim', runner: id, capabilities }); }
    catch (error) { if (error.code === 'RUNNER_STOPPED') break; throw error; }
    const claim = answer.claim;
    if (!claim) { await sleep(idleMs); continue; }
    const held = { job: claim.job, runner: id, token: claim.token };
    say(`claimed ${claim.job} (attempt ${claim.attempt}) at ${claim.candidate}`);
    const checkout = await checkoutCandidate(cache, answer.trunk, claim.candidate, `${claim.job.replace(/[^A-Za-z0-9._-]/gu, '-')}-${claim.attempt}`);
    if (!checkout.ok || !claim.run?.length) {
      // A candidate this runner cannot fetch is an infrastructure wait: hand the job back, never a red receipt.
      say(`releasing ${claim.job}: ${checkout.ok ? 'the job names nothing to run' : checkout.reason}`);
      if (checkout.ok) await dropCheckout(cache, checkout.folder);
      await reliably({ action: 'release', ...held }).catch(error => { if (error.code !== 'JOB_LEASE_MOVED') throw error; });
      jobs.push({ job: claim.job, outcome: 'released' });
      if (once) break;
      continue;
    }
    const started = Date.now();
    const running = runJob(claim.run, checkout.folder, { ceilingMs });
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
    const result = await running.done.finally(() => clearInterval(renewer));
    await dropCheckout(cache, checkout.folder);
    if (lost) { say(`lost the lease on ${claim.job}; another runner may hold it`); jobs.push({ job: claim.job, outcome: 'lost' }); if (once) break; continue; }
    const receipt = { status: result.status, signal: result.signal, commit: claim.candidate, run: claim.run, outputSha256: result.outputSha256,
      outputBytes: result.outputBytes, tail: result.tail, durationMs: Date.now() - started };
    try {
      await reliably({ action: 'receipt', ...held, receipt });
      say(`posted ${claim.job}: exit ${result.status}`);
      jobs.push({ job: claim.job, outcome: 'posted', receipt });
    } catch (error) {
      if (error.code !== 'JOB_LEASE_MOVED' && error.code !== 'RUNNER_STOPPED') throw error;
      jobs.push({ job: claim.job, outcome: 'lost' });
    }
    if (once) break;
  }
  return { jobs, waits };
}
