/**
 * Board-held `pullboard test` runs for agent seats: the seat queues a run and moves on, a detached worker runs it under
 * a job lease, and `pullboard next` hands the result back [C7].
 *
 * Why: since gate.runnersOnly a test run queues on runners for minutes, and seats sat 16-54 min in sleep-and-pgrep
 * loops. A seat never waits on a test run: the board holds the run and the seat takes other work.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
const disk = fileSystemAdapter();
import { dirname } from 'node:path';
import { join } from 'node:path';
import { AGENT_SHELL_MARKERS } from '../../../kernel/index.js';
import { Refused } from '../../../kernel/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { reclaimLapsed } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { renewLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { environmentAdapter } from '../../../env/index.js';

/** The job kind of a queued test run; the drive cell's gate reclaim never touches it. */
export const TEST_RUN_KIND = 'test-run';

/** The step `next` writes once it handed a finished run to its seat, so it is told once. */
export const DELIVERED = 'delivered';

/** How long a queued run may wait for its worker to take it before it is reported refused, not queued. */
export const START_BOUND_MS = LEASE_MS;

/** The step that ends a run whose worker is gone: it frees the job's lease and reads as lost. */
export const LOST = 'lost';

/** The step a pulled run's worker writes once it offered its runner job: the job id and how long it may wait unclaimed. */
export const PULLED = 'pulled';

/** The step `pullboard test --cancel` writes: it ends a queued or running run and frees its slot. */
export const CANCELLED = 'cancelled';

/** The last line a finished worker writes to its log: its verdict, runner and seconds. */
const FINAL_LINE = /^pullboard test: (red|green) on (\S+) in (\d+(?:\.\d+)?)s/mu;

/** How often a worker renews its lease: well inside the 2-minute liveness window. */
const RENEW_MS = 30_000;

/**
 * True when this `pullboard test` call belongs to an agent seat and so queues instead of blocking: a joined seat
 * (not the main checkout), not machine work, and not itself a queued run's worker. A seat holding a claim always
 * queues, whatever `--wait`, PULLBOARD_TEST_WAIT or its shell says; a seat holding none queues only inside an agent
 * shell without either.
 *
 * Why the claim decides: about 80 `pullboard test --wait` processes, each an agent waiting on runner results, ran the
 * coordinator Mac out of memory on 11 Nov, and ssh-launched seats carry no agent marker. A claim is board state no
 * shell can lose; a person or a script with no claim keeps the blocking answer it always had [P7].
 *
 * @param {any} ctx
 * @param {string|undefined} agent - The seat's agent id, or undefined when the checkout has no seat.
 * @param {Record<string, any>} values - The parsed switches.
 * @param {NodeJS.ProcessEnv} [environment]
 * @param {{ alive?: (pid: number) => boolean, pid?: number, claimed?: boolean }} [options] - `claimed`: the seat holds
 *   at least one live build claim.
 * @returns {boolean}
 */
export function queuesTestRun(ctx, agent, values, environment = environmentAdapter().all(), { alive = pidAlive, pid = process.pid, claimed = false } = {}) {
  if (values['test-run'] !== undefined || ctx.info.isMain || agent === undefined) return false;
  if (machineContext(environment, { alive, pid }) !== null) return false;
  if (claimed) return true;
  if (values.wait === true || environment.PULLBOARD_TEST_WAIT === '1') return false;
  return AGENT_SHELL_MARKERS.some(name => Boolean(environment[name]));
}

/**
 * Variables the machine sets for work that reads an exit code: a runner job, a landing shard, a test runner's
 * children, a composed hook, an item check or `pullboard run` agent, a gate slot, node:test, git hooks and the
 * check runner's clean git environment, and CI. Any one of them means the call is not a seat at its own prompt.
 */
export const MACHINE_CONTEXT_ENV = Object.freeze([
  'PULLBOARD_RUNNER_JOB', 'PULLBOARD_LANDING_RUN', 'PULLBOARD_TEST_RUNNER_PID', 'PULLBOARD_HOOK_COMPOSED',
  'PULLBOARD_CHECK', 'PULLBOARD_ITEM', 'PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_TOKEN', 'NODE_TEST_CONTEXT',
  'GIT_EXEC_PATH', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'CI',
]);

/**
 * Name why this call runs inside machine work and must block, or null when it is a seat at its own prompt.
 *
 * Why the CLI pid: every in-process pullboard command sets PULLBOARD_CLI_PID to itself unless a live outer command
 * set it first, so a `pullboard test` started by a live gate, check, landing, submit worker or sentinel sees another
 * live pid and blocks, whatever variables that work's author did or did not set. A check that gets a queued answer
 * would read exit 0 as a pass [C7].
 *
 * @param {NodeJS.ProcessEnv} environment
 * @param {{ alive?: (pid: number) => boolean, pid?: number }} [options]
 * @returns {string | null}
 */
export function machineContext(environment, { alive = pidAlive, pid = process.pid } = {}) {
  const set = MACHINE_CONTEXT_ENV.find(name => environment[name] !== undefined && environment[name] !== '');
  if (set) return set;
  const outer = Number(environment.PULLBOARD_CLI_PID);
  if (Number.isSafeInteger(outer) && outer > 0 && outer !== pid && alive(outer)) return 'PULLBOARD_CLI_PID';
  return null;
}

/** True when a process with this pid exists. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** Where a run's worker writes its own stdout and stderr. */
function workerLog(ctx, id) {
  return join(ctx.info.commonDir, 'pullboard', 'test-runs', `${id}.log`);
}

/**
 * The item a test run records on its job: the one `--item` names, else the item folder the command runs in when the
 * seat holds that claim, else the seat's sole claim. Why: a seat with several claims running from one item folder
 * left the job with no item, so the stale sweep could not see its run in flight (#6130).
 *
 * @param {{ named?: number, folder?: number | null, claims?: number[] }} from
 * @returns {number | undefined}
 */
export function testRunItem({ named, folder = null, claims = [] }) {
  if (named !== undefined) return named;
  if (folder !== null && claims.includes(folder)) return folder;
  return claims.length === 1 ? claims[0] : undefined;
}

/**
 * Record a queued run on the board and start its detached worker. Returns at once with the run id.
 *
 * @param {any} ctx
 * @param {(work: (board: any) => any) => any} withBoard - Runs `work` on a writable board handle.
 * @param {{ agent: string, item?: number, items?: number[], named?: boolean, head?: string, files: string[], affected?: boolean, compareMain?: boolean, noFileLimit?: boolean }} run
 * @param {{ launch?: typeof spawn, now?: number, bin?: string, runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on (boardRunsHolder); the run's job rows go to its handle and not to the board [P7,#9080]. `bin`: the CLI entry the worker runs, the build
 *   that queued it; the caller names it so this package names no app [C7].
 * @returns {{ id: string, status: 'queued', log: string, files: string[] }}
 */
export function queueTestRun(ctx, withBoard, run, { launch = spawn, now = Date.now(), bin, runs = null } = {}) {
  if (launch === spawn && (typeof bin !== 'string' || !bin)) throw new Refused('NO_CLI_ENTRY', 'name the CLI entry the run worker launches: queueTestRun(..., { bin: <path to the pullboard entry> })');
  const id = randomUUID();
  const log = workerLog(ctx, id);
  withBoard(board => {
    createJob(runs?.db ?? board.db, { id, kind: TEST_RUN_KIND, item: run.item ?? null, now });
    writeStep(runs?.db ?? board.db, id, 'queued', { agent: run.agent, items: run.items ?? [], head: run.head ?? null, files: run.files, affected: run.affected === true,
      compareMain: run.compareMain === true, noFileLimit: run.noFileLimit === true, root: ctx.info.root, log }, { now });
  });
  disk.mkdir(dirname(log), { recursive: true, mode: 0o700 });
  const out = disk.open(log, 'a', 0o600);
  try {
    const args = [bin, 'test', '--test-run', id, ...run.files, ...(run.named && run.item !== undefined ? ['--item', String(run.item)] : []),
      ...(run.affected ? ['--affected'] : []), ...(run.compareMain ? ['--compare-main'] : []), ...(run.noFileLimit ? ['--no-file-limit'] : [])];
    const child = launch(process.execPath, args, { cwd: ctx.info.root, detached: true, stdio: ['ignore', out, out],
      // The worker runs the build that queued it, never a main-checkout hand-off that may predate --test-run.
      env: { ...environmentAdapter().all(), PULLBOARD_TEST_WAIT: '1', PULLBOARD_OWN_CLI: '1' } });
    child.unref();
  } finally { disk.close(out); }
  return { id, status: 'queued', log, files: run.files };
}

/**
 * Run a queued run's work as its worker: hold the job lease with a heartbeat, record the result, finish the job.
 * A worker that dies stops renewing, and `next` reports the run lost 2 minutes later, never silently.
 *
 * @param {(work: (board: any) => any) => any} withBoard
 * @param {string} id
 * @param {() => Promise<object>} work - The blocking run; resolves to the result payload.
 * Each beat also calls `beatSeat`, so the queuing seat reads alive while its run is live, even on a remote runner where
 * its own machine runs no test process; the stale sweep would otherwise free the claim after 2 quiet minutes [B28].
 * The caller injects it because the drive cell does not import the store.
 *
 * @param {{ renewMs?: number, beatSeat?: (board: any) => void, runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on (boardRunsHolder); the run's job rows go to its handle and not to the board [P7,#9080].
 * @returns {Promise<object>} The recorded result.
 */
export async function workTestRun(withBoard, id, work, { renewMs = RENEW_MS, beatSeat = null, runs = null } = {}) {
  const owner = `test-run:${process.pid}`;
  const held = board => runs?.db ?? board.db;
  if (withBoard(board => jobView(held(board), id))?.steps.some(row => row.name === CANCELLED)) throw new Refused('TEST_RUN_CANCELLED', `test run ${id} was cancelled; queue it again with pullboard test`);
  const taken = withBoard(board => takeJob(held(board), id, owner, { leaseMs: LEASE_MS }));
  if (!taken.taken) throw new Refused('TEST_RUN_TAKEN', `test run ${id} already has a live worker; read it with pullboard test --status ${id}`);
  withBoard(board => { writeStep(held(board), id, 'running', { pid: process.pid }); beatSeat?.(board); });
  const beat = setInterval(() => { try { withBoard(board => { renewLease(held(board), id, owner); beatSeat?.(board); }); } catch { /* the next beat retries */ } }, renewMs);
  let result;
  try { result = await work(); }
  catch (error) { result = { green: false, error: { code: error?.code ?? 'TEST_RUN_FAILED', message: String(error?.message ?? error) } }; }
  finally { clearInterval(beat); }
  withBoard(board => { writeStep(held(board), id, 'result', result); finishJob(held(board), id, owner); });
  return result;
}

/**
 * One run's state as a plain record: queued, running, green, red, lost or refused (never taken in time), with its files, result and log.
 *
 * @param {ReturnType<typeof jobView>} view
 * @param {number} [now]
 * @returns {{ id: string, status: string, agent: string|null, files: string[], log: string|null, result: any, refusal: {code: string, message: string}|null, delivered: boolean } | null}
 */
export function testRunState(view, now = Date.now(), { finalLine = null, pulled = null } = {}) {
  if (!view || view.kind !== TEST_RUN_KIND) return null;
  const step = name => view.steps.find(row => row.name === name)?.payload;
  const queued = step('queued') ?? {};
  let result = step('result') ?? null;
  const delivered = view.steps.some(row => row.name === DELIVERED);
  // A worker prints its verdict to the log before it records the result; when the record never lands the log still ends the run.
  if (!result && finalLine) result = { green: finalLine.green, runner: finalLine.runner, seconds: finalLine.seconds, counts: null,
    failures: [], logPath: queued.log ?? null, files: queued.files ?? [], notices: ['result read from the log: the worker did not record it on the board'] };
  // A pulled run's runner receipt outlives its worker: it wins over a lost worker (#7574).
  if (!result && pulled?.receipt) {
    const recording = Boolean(view.leaseOwner) && view.leaseUntil >= now;
    result = pulledResult(pulled, queued, { recording });
  }
  let status;
  let refusal = null;
  if (view.steps.some(row => row.name === CANCELLED)) status = 'cancelled';
  else if (result) status = result.green ? 'green' : 'red';
  else if (pulled?.pending) status = 'running';
  else if (view.steps.some(row => row.name === LOST)) status = 'lost';
  else if (view.leaseOwner) status = view.leaseUntil < now ? 'lost' : 'running';
  else if (view.created + START_BOUND_MS < now) {
    status = 'refused';
    refusal = { code: 'TEST_RUN_NOT_STARTED', message: `no worker took this run within ${Math.round(START_BOUND_MS / 1000)}s of queueing` };
  } else status = 'queued';
  return { id: view.id, status, agent: queued.agent ?? null, item: view.item, files: queued.files ?? [],
    log: result?.logPath ?? queued.log ?? null, result, refusal, delivered };
}

/**
 * The runner job a pulled run's worker offered, read from the board: its posted receipt, or pending while a runner
 * holds it or it may still be claimed; null for a run with no pulled job, or one that ended with no receipt.
 *
 * Why: a worker that stops (its starting client's session ended) leaves the runner job running; the run is the
 * runner's to settle, not lost (#7574).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof jobView>} view - The test run's job view.
 * @param {number} [now]
 * @returns {{ job: string, receipt?: object, runner?: string | null, pending?: true } | null}
 */
export function pulledJobState(db, view, now = Date.now()) {
  const offered = view?.steps.findLast(row => row.name === PULLED)?.payload;
  if (typeof offered?.job !== 'string') return null;
  const job = jobView(db, offered.job);
  if (!job) return null;
  const posted = job.steps.findLast(row => row.name === 'receipt')?.payload;
  if (posted) return { job: job.id, receipt: posted.receipt ?? {}, runner: posted.runner ?? null };
  if (job.step === 'done') return null;
  const held = Boolean(job.leaseOwner) && job.leaseUntil >= now;
  return held || now < Number(offered.until ?? 0) ? { job: job.id, pending: true } : null;
}

/**
 * A pulled job's receipt as a run result, read the way the worker reads it: green only when every layer says so.
 * `recording` is true while the run's worker still holds a live lease: it is comparing with main, not stopped (#8851).
 */
function pulledResult(pulled, queued, { recording = false } = {}) {
  const { receipt } = pulled;
  const gate = receipt.gate ?? {};
  const phase = gate.phases?.[0] ?? null;
  const green = receipt.status === 0 && gate.green === true && phase?.status === 0;
  const failures = Array.isArray(phase?.failures) ? phase.failures : [];
  return { green, runner: pulled.runner ?? 'a pulled runner',
    seconds: Number.isFinite(receipt.durationMs) ? Math.round(receipt.durationMs / 1000) : null, counts: null,
    failures, logPath: queued.log ?? null, files: queued.files ?? [],
    notices: [`result read from the runner receipt of test job ${pulled.job}: ${recording ? 'the worker is still recording it' : 'the worker stopped before recording it'}`,
      ...(green || failures.length ? [] : receiptVerdictLines(gate.verdicts))] };
}

/**
 * One line per file a red receipt's verdicts name, with its first case, for a receipt whose phase lists no failures.
 * Why: 37 red runs on 17 Nov were read from the receipt with no failing file printed, so builders reran or opened the log;
 * these are notices only, so the main comparison that reads `failures` is unchanged (#10678).
 *
 * @param {unknown} verdicts - The receipt's gate.verdicts: test file -> its failing case names.
 * @returns {string[]}
 */
function receiptVerdictLines(verdicts) {
  if (!verdicts || typeof verdicts !== 'object' || Array.isArray(verdicts)) return [];
  return Object.entries(verdicts).map(([file, cases]) => {
    const first = Array.isArray(cases) && typeof cases[0] === 'string' ? cases[0] : null;
    return `failing (from the receipt): ${file}${first && first !== file && !first.endsWith(`/${file}`) ? `: ${first}` : ''}`;
  });
}

/**
 * The verdict a finished worker printed as the last line of its log, or null while the log has none.
 *
 * @param {string|null|undefined} path
 * @returns {{ green: boolean, runner: string, seconds: number } | null}
 */
export function readFinalLine(path) {
  if (!path) return null;
  let fd;
  try {
    fd = disk.open(path, 'r');
    const size = disk.fstat(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 8192));
    disk.read(fd, buffer, 0, buffer.length, size - buffer.length);
    const match = FINAL_LINE.exec(buffer.toString('utf8'));
    return match ? { green: match[1] === 'green', runner: match[2], seconds: Number(match[3]) } : null;
  } catch { return null; } finally { if (fd !== undefined) disk.close(fd); }
}

/**
 * End every test run whose lease lapsed and whose worker process is gone: record a `lost` step and free the lease,
 * so the run reads lost, `next` hands that back once, and the dead row stops holding a slot.
 *
 * Why: a worker killed mid-run stopped renewing, but nothing ever wrote an ending, so rows sat running for up to 30
 * hours; the liveness rule is that every hold heartbeats or is reclaimed within 2 minutes (`waits record` runs this each minute).
 *
 * @param {import('node:sqlite').DatabaseSync} db - A board handle opened for writing.
 * @param {{ now?: number, alive?: (pid: number) => boolean, runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on (boardRunsHolder); the run's job rows go to its handle and not to the board [P7,#9080].
 * @returns {{ id: string, lapsedMs: number, pid: number | null }[]} The runs ended.
 */
export function endLostTestRuns(db, { now = Date.now(), alive = pidAlive, runs = null } = {}) {
  const jobs = runs?.db ?? db;
  const ended = [];
  for (const job of reclaimLapsed(jobs, { now })) {
    if (job.kind !== TEST_RUN_KIND) continue;
    const view = jobView(jobs, job.id);
    if (!view || view.steps.some(row => row.name === 'result' || row.name === LOST)) continue;
    const pid = Number(/^test-run:(\d+)$/u.exec(job.leaseOwner)?.[1]);
    const known = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    if (known !== null && alive(known)) continue;
    // A runner still holds or may claim the run's pulled job, or posted it: the receipt settles the run, never lost (#7574).
    const pulled = pulledJobState(jobs, view, now);
    if (pulled?.pending) continue;
    if (pulled?.receipt) {
      writeStep(jobs, job.id, 'result', pulledResult(pulled, view.steps.find(row => row.name === 'queued')?.payload ?? {}), { now });
      finishJob(jobs, job.id, job.leaseOwner, { now });
      continue;
    }
    writeStep(jobs, job.id, LOST, { pid: known, lapsedMs: job.lapsedMs }, { now });
    finishJob(jobs, job.id, job.leaseOwner, { now });
    ended.push({ id: job.id, lapsedMs: job.lapsedMs, pid: known });
  }
  return ended;
}

/**
 * Read one run by its id, or a unique prefix of it.
 *
 * @param {any} board
 * @param {string} id
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on; the run is read from its handle [P7,#9080].
 * @returns {ReturnType<typeof testRunState>}
 */
export function readTestRun(board, id, { runs = null } = {}) {
  const jobs = runs?.db ?? board.db;
  const rows = jobs.prepare('SELECT job_id FROM job WHERE job_kind = ? AND job_id LIKE ? LIMIT 2').all(TEST_RUN_KIND, `${String(id).replace(/[%_]/gu, '')}%`);
  if (rows.length !== 1) throw new Refused('NO_TEST_RUN', `${rows.length ? 'more than one' : 'no'} test run matches ${id}; pass the full run id that pullboard test printed`);
  return viewState(jobs, jobView(jobs, rows[0].job_id), board.clock?.now?.().getTime?.() ?? Date.now());
}

/**
 * Cancel the calling seat's queued or running run: record `cancelled`, end the job so its slot frees, and stop the worker
 * process group (it owns the runner process). `next` then reports the run once as cancelled.
 *
 * Why: two proof runs sat on an overloaded runner for 12+ minutes and the builder had no way to cancel and requeue them.
 *
 * @param {any} board - A writable board handle.
 * @param {string} id - A run id or unique prefix.
 * @param {string} agent - The calling seat; only the run's owner may cancel it.
 * @param {{ kill?: (pid: number, signal: string) => void, runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on [P7,#9080].
 * @returns {NonNullable<ReturnType<typeof testRunState>>} The run, now cancelled.
 */
export function cancelTestRun(board, id, agent, { kill = process.kill, runs = null } = {}) {
  const jobs = runs?.db ?? board.db;
  const run = readTestRun(board, id, { runs });
  if (run.agent !== agent) throw new Refused('NOT_YOURS', `test run ${run.id} belongs to ${run.agent ?? 'another seat'}; only its owner cancels it; read it with pullboard test --status ${run.id}`);
  if (!['queued', 'running'].includes(run.status)) throw new Refused('TEST_RUN_FINISHED', `test run ${run.id} already ${run.status}; nothing to cancel; queue a new one with pullboard test`);
  const view = jobView(jobs, run.id);
  const pid = view.steps.find(row => row.name === 'running')?.payload?.pid;
  writeStep(jobs, run.id, CANCELLED, { pid: Number.isSafeInteger(pid) ? pid : null });
  finishJob(jobs, run.id, view.leaseOwner);
  if (Number.isSafeInteger(pid) && pid > 1) for (const target of [-pid, pid]) { try { kill(target, 'SIGTERM'); break; } catch { /* the worker is already gone */ } }
  return readTestRun(board, run.id, { runs });
}

/** A job view as a run state, reading the worker's log and its pulled job only for a run that has no recorded result. */
function viewState(db, view, now) {
  const unfinished = view?.kind === TEST_RUN_KIND && !view.steps.some(row => row.name === 'result');
  const log = unfinished ? view.steps.find(row => row.name === 'queued')?.payload?.log : null;
  return testRunState(view, now, { finalLine: readFinalLine(log), pulled: unfinished ? pulledJobState(db, view, now) : null });
}

/**
 * Every run of this seat that `next` has not handed back yet, oldest first.
 *
 * @param {any} board
 * @param {string} agent
 * @param {number} [now]
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on [P7,#9080].
 * @returns {NonNullable<ReturnType<typeof testRunState>>[]}
 */
export function ownTestRuns(board, agent, now = Date.now(), { runs = null } = {}) {
  const jobs = runs?.db ?? board.db;
  // Why the agent filter in SQL: a board holds tens of thousands of finished runs of seats that never called next again,
  // and reading each one's steps before filtering cost every next about 2 s (20 Nov). A queued payload kept in the blob
  // store shows no agent to SQL, so it still goes through the agent check below.
  return jobs.prepare(`SELECT job.job_id FROM job LEFT JOIN job_step queued ON queued.job_step_job = job.job_id
    AND queued.job_step_name = 'queued' AND queued.job_step_seq = 0
    WHERE job.job_kind = ? AND job.job_step <> ?
      AND (json_extract(queued.job_step_payload, '$.agent') = ? OR json_extract(queued.job_step_payload, '$.agent') IS NULL)
    ORDER BY job.job_created, job.job_id`).all(TEST_RUN_KIND, DELIVERED, agent)
    .map(row => viewState(jobs, jobView(jobs, row.job_id), now)).filter(run => run && run.agent === agent);
}

/** Mark a run handed back, so `next` tells its seat once. */
export function deliverTestRun(board, id, { runs = null } = {}) {
  writeStep(runs?.db ?? board.db, id, DELIVERED, {});
}

/**
 * Hand this seat every finished or lost run `next` has not told it of yet, first, the way a red gate comes back,
 * and mark each delivered. Read first: a seat with nothing finished opens no write handle.
 *
 * @param {any} io
 * @param {any} ctx
 * @param {{ withBoard: Function, withBoardRead: Function, whoAmI: Function }} services
 * @returns {{ delivered: number, pending: string[] }} How many runs came back, and the ids still queued or running.
 */
export function deliverOwnTestRuns(io, ctx, { withBoard, withBoardRead, whoAmI }) {
  const now = () => ctx.clock?.now?.().getTime?.() ?? Date.now();
  const runs = withBoardRead(ctx, board => ownTestRuns(board, whoAmI(ctx, board).id, now()));
  const finished = runs.filter(run => !['queued', 'running'].includes(run.status));
  if (finished.length) withBoard(ctx, board => { for (const run of finished) deliverTestRun(board, run.id); });
  for (const run of finished) for (const line of testRunLines(run)) io.say(line);
  return { delivered: finished.length, pending: runs.filter(run => ['queued', 'running'].includes(run.status)).map(run => run.id) };
}

/**
 * Hold an idle `next` until one of the seat's queued test runs finishes or is lost, then hand it back. Returns true
 * when a run came back, false when none is pending. Why: a seat with no other item would otherwise end its turn and
 * never hear the result; a lost worker stops renewing its lease, so this ends within 2 minutes of a dead run.
 *
 * @param {any} io
 * @param {any} ctx
 * @param {{ withBoard: Function, withBoardRead: Function, whoAmI: Function }} services
 * @param {() => { version: () => number, wait: (options: { after: number, deadline: number }) => Promise<unknown>, close: () => void }} watch - A waiter on the board file.
 * @param {{ rearmMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function deliverTestRunsWhenReady(io, ctx, services, watch, { rearmMs = 15_000 } = {}) {
  const wake = watch();
  try {
    for (;;) {
      const version = wake.version();
      const runs = deliverOwnTestRuns(io, ctx, services);
      if (runs.delivered) return true;
      if (!runs.pending.length) return false;
      // The deadline rereads lease state, so a worker that died without writing is reported lost.
      await wake.wait({ after: version, deadline: Date.now() + rearmMs });
    }
  } finally { wake.close(); }
}

/**
 * The lines `next` prints for one finished or lost run: the outcome, each failing test, the log.
 *
 * @param {NonNullable<ReturnType<typeof testRunState>>} run
 * @returns {string[]}
 */
export function testRunLines(run) {
  const files = run.files.length ? run.files.join(' ') : '--affected';
  if (run.status === 'refused') return [`test run ${run.id} refused: [${run.refusal.code}] ${run.refusal.message}; run pullboard test ${files} again`,
    ...(run.log ? [`  log: ${run.log}`] : [])];
  if (run.status === 'cancelled') return [`test run ${run.id} cancelled: ${files}; queue it again with pullboard test ${files}`];
  if (run.status === 'lost') return [`test run ${run.id} lost: its worker stopped before a result; run pullboard test ${files} again`,
    ...(run.log ? [`  log: ${run.log}`] : [])];
  const result = run.result ?? {};
  const where = result.runner ? ` on ${result.runner}${Number.isFinite(result.seconds) ? ` in ${result.seconds}s` : ''}` : '';
  return [`test run ${run.id} ${run.status}${where}: ${files}`,
    ...(result.error ? [`  refused: [${result.error.code}] ${result.error.message}`] : []),
    ...(result.failures ?? []).map(row => `  failing: ${row.file ?? '(file unavailable)'}: ${row.name}: ${row.error}`),
    ...(result.notices ?? []).map(line => `  ${line}`),
    ...(run.log ? [`  log: ${run.log}`] : [])];
}
