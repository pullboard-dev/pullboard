/**
 * Board-held `pullboard test` runs for agent seats: the seat queues a run and moves on, a detached worker runs it under
 * a job lease, and `pullboard next` hands the result back [C7].
 *
 * Why: since gate.runnersOnly a test run queues on runners for minutes, and seats sat 16-54 min in sleep-and-pgrep
 * loops. Corey, 9 Nov: "waiting is an error". The board holds the run; the seat takes other work.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { readSync } from 'node:fs';
import { openSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** The job kind of a queued test run; the drive cell's gate reclaim never touches it. */
export const TEST_RUN_KIND = 'test-run';

/** The step `next` writes once it handed a finished run to its seat, so it is told once. */
export const DELIVERED = 'delivered';

/** How long a queued run may wait for its worker to take it before it is reported refused, not queued. */
export const START_BOUND_MS = LEASE_MS;

/** The step that ends a run whose worker is gone: it frees the job's lease and reads as lost. */
export const LOST = 'lost';

/** The last line a finished worker writes to its log: its verdict, runner and seconds. */
const FINAL_LINE = /^pullboard test: (red|green) on (\S+) in (\d+(?:\.\d+)?)s/mu;

/** How often a worker renews its lease: well inside the 2-minute liveness window. */
const RENEW_MS = 30_000;

/** The CLI entry a worker runs, the same build that queued it. */
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/cli/pullboard.js');

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
export function queuesTestRun(ctx, agent, values, environment = process.env, { alive = pidAlive, pid = process.pid, claimed = false } = {}) {
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
 * Record a queued run on the board and start its detached worker. Returns at once with the run id.
 *
 * @param {any} ctx
 * @param {(work: (board: any) => any) => any} withBoard - Runs `work` on a writable board handle.
 * @param {{ agent: string, item?: number, items?: number[], named?: boolean, head?: string, files: string[], affected?: boolean, compareMain?: boolean }} run
 * @param {{ launch?: typeof spawn, now?: number }} [options]
 * @returns {{ id: string, status: 'queued', log: string, files: string[] }}
 */
export function queueTestRun(ctx, withBoard, run, { launch = spawn, now = Date.now() } = {}) {
  const id = randomUUID();
  const log = workerLog(ctx, id);
  withBoard(board => {
    createJob(board.db, { id, kind: TEST_RUN_KIND, item: run.item ?? null, now });
    writeStep(board.db, id, 'queued', { agent: run.agent, items: run.items ?? [], head: run.head ?? null, files: run.files, affected: run.affected === true,
      compareMain: run.compareMain === true, root: ctx.info.root, log }, { now });
  });
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const out = openSync(log, 'a', 0o600);
  try {
    const args = [BIN, 'test', '--test-run', id, ...run.files, ...(run.named && run.item !== undefined ? ['--item', String(run.item)] : []),
      ...(run.affected ? ['--affected'] : []), ...(run.compareMain ? ['--compare-main'] : [])];
    const child = launch(process.execPath, args, { cwd: ctx.info.root, detached: true, stdio: ['ignore', out, out],
      // The worker runs the build that queued it, never a main-checkout hand-off that may predate --test-run.
      env: { ...process.env, PULLBOARD_TEST_WAIT: '1', PULLBOARD_OWN_CLI: '1' } });
    child.unref();
  } finally { closeSync(out); }
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
 * @param {{ renewMs?: number, beatSeat?: (board: any) => void }} [options]
 * @returns {Promise<object>} The recorded result.
 */
export async function workTestRun(withBoard, id, work, { renewMs = RENEW_MS, beatSeat = null } = {}) {
  const owner = `test-run:${process.pid}`;
  const taken = withBoard(board => takeJob(board.db, id, owner, { leaseMs: LEASE_MS }));
  if (!taken.taken) throw new Refused('TEST_RUN_TAKEN', `test run ${id} already has a live worker; read it with pullboard test --status ${id}`);
  withBoard(board => { writeStep(board.db, id, 'running', { pid: process.pid }); beatSeat?.(board); });
  const beat = setInterval(() => { try { withBoard(board => { renewLease(board.db, id, owner); beatSeat?.(board); }); } catch { /* the next beat retries */ } }, renewMs);
  let result;
  try { result = await work(); }
  catch (error) { result = { green: false, error: { code: error?.code ?? 'TEST_RUN_FAILED', message: String(error?.message ?? error) } }; }
  finally { clearInterval(beat); }
  withBoard(board => { writeStep(board.db, id, 'result', result); finishJob(board.db, id, owner); });
  return result;
}

/**
 * One run's state as a plain record: queued, running, green, red, lost or refused (never taken in time), with its files, result and log.
 *
 * @param {ReturnType<typeof jobView>} view
 * @param {number} [now]
 * @returns {{ id: string, status: string, agent: string|null, files: string[], log: string|null, result: any, refusal: {code: string, message: string}|null, delivered: boolean } | null}
 */
export function testRunState(view, now = Date.now(), { finalLine = null } = {}) {
  if (!view || view.kind !== TEST_RUN_KIND) return null;
  const step = name => view.steps.find(row => row.name === name)?.payload;
  const queued = step('queued') ?? {};
  let result = step('result') ?? null;
  const delivered = view.steps.some(row => row.name === DELIVERED);
  // A worker prints its verdict to the log before it records the result; when the record never lands the log still ends the run.
  if (!result && finalLine) result = { green: finalLine.green, runner: finalLine.runner, seconds: finalLine.seconds, counts: null,
    failures: [], logPath: queued.log ?? null, files: queued.files ?? [], notices: ['result read from the log: the worker did not record it on the board'] };
  let status;
  let refusal = null;
  if (result) status = result.green ? 'green' : 'red';
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
 * The verdict a finished worker printed as the last line of its log, or null while the log has none.
 *
 * @param {string|null|undefined} path
 * @returns {{ green: boolean, runner: string, seconds: number } | null}
 */
export function readFinalLine(path) {
  if (!path) return null;
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 8192));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const match = FINAL_LINE.exec(buffer.toString('utf8'));
    return match ? { green: match[1] === 'green', runner: match[2], seconds: Number(match[3]) } : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * End every test run whose lease lapsed and whose worker process is gone: record a `lost` step and free the lease,
 * so the run reads lost, `next` hands that back once, and the dead row stops holding a slot.
 *
 * Why: a worker killed mid-run stopped renewing, but nothing ever wrote an ending, so rows sat running for up to 30
 * hours; the liveness rule is that every hold heartbeats or is reclaimed within 2 minutes (`waits record` runs this each minute).
 *
 * @param {import('node:sqlite').DatabaseSync} db - A board handle opened for writing.
 * @param {{ now?: number, alive?: (pid: number) => boolean }} [options]
 * @returns {{ id: string, lapsedMs: number, pid: number | null }[]} The runs ended.
 */
export function endLostTestRuns(db, { now = Date.now(), alive = pidAlive } = {}) {
  const ended = [];
  for (const job of reclaimLapsed(db, { now })) {
    if (job.kind !== TEST_RUN_KIND) continue;
    const view = jobView(db, job.id);
    if (!view || view.steps.some(row => row.name === 'result' || row.name === LOST)) continue;
    const pid = Number(/^test-run:(\d+)$/u.exec(job.leaseOwner)?.[1]);
    const known = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    if (known !== null && alive(known)) continue;
    writeStep(db, job.id, LOST, { pid: known, lapsedMs: job.lapsedMs }, { now });
    finishJob(db, job.id, job.leaseOwner, { now });
    ended.push({ id: job.id, lapsedMs: job.lapsedMs, pid: known });
  }
  return ended;
}

/**
 * Read one run by its id, or a unique prefix of it.
 *
 * @param {any} board
 * @param {string} id
 * @returns {ReturnType<typeof testRunState>}
 */
export function readTestRun(board, id) {
  const rows = board.db.prepare('SELECT job_id FROM job WHERE job_kind = ? AND job_id LIKE ? LIMIT 2').all(TEST_RUN_KIND, `${String(id).replace(/[%_]/gu, '')}%`);
  if (rows.length !== 1) throw new Refused('NO_TEST_RUN', `${rows.length ? 'more than one' : 'no'} test run matches ${id}; pass the full run id that pullboard test printed`);
  return viewState(jobView(board.db, rows[0].job_id), board.clock?.now?.().getTime?.() ?? Date.now());
}

/** A job view as a run state, reading the worker's log only for a run that has no recorded result. */
function viewState(view, now) {
  const unfinished = view?.kind === TEST_RUN_KIND && !view.steps.some(row => row.name === 'result');
  const log = unfinished ? view.steps.find(row => row.name === 'queued')?.payload?.log : null;
  return testRunState(view, now, { finalLine: readFinalLine(log) });
}

/**
 * Every run of this seat that `next` has not handed back yet, oldest first.
 *
 * @param {any} board
 * @param {string} agent
 * @param {number} [now]
 * @returns {NonNullable<ReturnType<typeof testRunState>>[]}
 */
export function ownTestRuns(board, agent, now = Date.now()) {
  return board.db.prepare('SELECT job_id FROM job WHERE job_kind = ? AND job_step <> ? ORDER BY job_created, job_id').all(TEST_RUN_KIND, DELIVERED)
    .map(row => viewState(jobView(board.db, row.job_id), now)).filter(run => run && run.agent === agent);
}

/** Mark a run handed back, so `next` tells its seat once. */
export function deliverTestRun(board, id) {
  writeStep(board.db, id, DELIVERED, {});
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
