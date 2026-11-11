/** At most N submit-handoff workers run on the machine at once; the rest wait unspawned in submit order [C7]. */
import { availableParallelism } from 'node:os';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import {
  listResources,
  takeResource,
} from '../../main.js';
import { reuseResourceConnections } from '../../connections.js';
import { machineHome } from '../../home.js';
import { AGENT_SESSION_IDS } from '../../../../../kernel/light.js';
import { Refused } from '../../../../../kernel/light.js';
import {
  handoffRoots,
  pruneFinishedHandoffs,
  rememberHandoffRoot,
} from '../prune.js';

/** The machine resource whose slots count running handoff workers. */
export const HANDOFF_WORKER_RESOURCE = 'submit-handoff-workers';

/** The machine resource held by the one dispatcher that starts queued workers. */
export const HANDOFF_DISPATCHER_RESOURCE = 'submit-handoff-dispatcher';

/** How long a worker may run on after writing its result before the dispatcher stops it; with the kill it stays under 2 minutes. */
export const HANDOFF_RESULT_GRACE_MS = 100_000;

/** How long a stopped worker has to close before its whole process group is killed. */
const HANDOFF_STOP_KILL_MS = 10_000;

/** The environment variable that overrides the worker cap. */
export const HANDOFF_WORKER_CAP_ENV = 'PULLBOARD_HANDOFF_WORKERS';
/** The most hand-off workers this machine runs at once, whatever the runner fleet offers. */
export const DISPATCH_WORKER_BOUND = 16;

/** Preserve the launching seat's environment while preventing detached processes from inheriting its session identity. */
function handoffProcessEnvironment(env = process.env) {
  const clean = { ...env };
  for (const name of AGENT_SESSION_IDS) delete clean[name];
  return clean;
}

/**
 * The variable a dispatcher sets on each gate worker it starts: the worker's stdin is a pipe the dispatcher holds, and
 * its end means the dispatcher exited, so the worker stops at once (#3899). A worker started any other way has no
 * lifeline and is unaffected.
 */
export const HANDOFF_WORKER_LIFELINE_ENV = 'PULLBOARD_WORKER_LIFELINE';

/**
 * Call `stop` once this worker's dispatcher exits: the pipe it holds on this process's stdin ends. A process started
 * without the lifeline is left alone, so a worker run by hand or by a test never stops on its own stdin.
 *
 * @param {() => unknown} stop
 * @param {{ env?: NodeJS.ProcessEnv, stdin?: NodeJS.ReadableStream }} [options]
 * @returns {boolean} Whether a lifeline is watched.
 */
export function onDispatcherLifelineEnd(stop, { env = process.env, stdin = process.stdin } = {}) {
  if (env[HANDOFF_WORKER_LIFELINE_ENV] !== '1') return false;
  stdin.once('end', stop);
  stdin.once('error', stop);
  stdin.resume();
  return true;
}

/** Keep the detached dispatcher functional without passing agent or command session state to it. */
function handoffDispatcherEnvironment(source) {
  const env = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'PULLBOARD_MACHINE_HOME',
    'PULLBOARD_ACCOUNT_HOME', 'PULLBOARD_TEST_RUNNER_PID', 'PULLBOARD_HOME']) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

/**
 * Count of handoff workers allowed at once, with where the number came from: the override when set, else the cores up
 * to a default of 4, raised to one worker per five registered runner slots, or to every runner slot when
 * gate.runnersOnly is on. Why: a handoff worker mostly waits on a remote runner, so on 3 Nov a cap of 4 left 69
 * submits queued while 42 of 54 runner slots sat idle, and on 4 Nov 51-60 gates queued behind 12 workers while 63
 * runner slots existed.
 *
 * The machine setting gate.handoffWorkers, passed as machineCap, sits between the two: the override still wins, then the
 * setting, then the computed number. Why: the dispatcher and every library caller must get the same cap from this one
 * function, so the setting is applied here and nowhere else [C7].
 *
 * @param {{ env?: object, cores?: number, runnerSlots?: number, runnersOnly?: boolean, machineCap?: number }} [options] - Environment, core count, total registered runner slots, whether checks run only on runners, and the machine setting gate.handoffWorkers when set.
 * @returns {{ cap: number, source: string }} A positive whole number and its origin, for the status line.
 */
export function handoffWorkerCapacityDetail({ env = process.env, cores = availableParallelism(), runnerSlots = 0, runnersOnly = false, machineCap } = {}) {
  const raw = env[HANDOFF_WORKER_CAP_ENV];
  if (raw !== undefined && raw !== '') {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Refused('BAD_HANDOFF_WORKER_CAP', `${HANDOFF_WORKER_CAP_ENV} must be a whole number of 1 or more; unset it for the default`);
    return { cap: value, source: `${HANDOFF_WORKER_CAP_ENV} override` };
  }
  if (Number.isSafeInteger(machineCap) && machineCap >= 1) return { cap: machineCap, source: 'gate.handoffWorkers machine setting' };
  const local = Math.max(1, Math.min(4, cores));
  if (!Number.isSafeInteger(runnerSlots) || runnerSlots < 1) return { cap: local, source: `local cores (${cores})` };
  // Each worker holds a Node process, a tool-tree copy and an SSH controller on this machine for its gate's whole run,
  // so the cap is bounded whatever the runner count: at 55 (every runner slot) the coordinator Mac ran 46 such
  // processes at load 47 on 6 Nov and every board command took seconds; at 12 the queue reached 70 submits an hour later, and at 20 the Mac went disk-bound (9,000 IOPS: each worker checks out the source and copies the tools) and every runner was quarantined; with the per-admission SSH probes off (loadAwareDispatch, measuredSlots) the Mac held load 32 at 20 workers, so 16 keeps the runners fed without the thrash. The bound lifts when gates become records
  // served by one dispatcher connection per runner [C7].
  const wanted = runnersOnly ? runnerSlots : Math.floor(runnerSlots / 5);
  const shared = Math.min(DISPATCH_WORKER_BOUND, wanted);
  if (shared > local) return { cap: shared, source: (runnersOnly ? `every runner slot (${runnerSlots}, gate.runnersOnly)` : `one per five runner slots (${runnerSlots})`) + (shared < wanted ? `, bounded at ${DISPATCH_WORKER_BOUND}` : '') };
  return { cap: local, source: `local cores (${cores})` };
}

/** Count of handoff workers allowed at once; see handoffWorkerCapacityDetail for the rule and its origin. */
export function handoffWorkerCapacity(options = {}) { return handoffWorkerCapacityDetail(options).cap; }

/** The file in which the running dispatcher records its live cap and where it came from. */
function handoffCapFile() { return join(handoffQueueDirectory(), 'worker-cap.json'); }

/**
 * Record the dispatcher's live cap and source for pullboard status; written only when it changes. Why: on 6 Nov
 * a dispatcher ran for six hours on a cap inherited from a seat's environment and nothing showed it.
 *
 * @param {{ cap: number, source: string }} detail - The cap and its origin.
 * @param {number} [pid] - The dispatcher process.
 */
export function recordHandoffCap(detail, pid = process.pid) {
  try {
    const file = handoffCapFile();
    try { const last = JSON.parse(readFileSync(file, 'utf8')); if (last.cap === detail.cap && last.source === detail.source && last.pid === pid) return; } catch { /* no usable record yet */ }
    mkdirSync(handoffQueueDirectory(), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ version: 1, cap: detail.cap, source: detail.source, pid, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch { /* a status record never stops the dispatcher */ }
}

/**
 * The status line for the dispatcher's recorded worker cap, or null when none has run.
 *
 * @returns {string | null} For example `handoff workers: cap 66 (every runner slot (66, gate.runnersOnly))`.
 */
export function handoffCapLine() {
  try {
    const recorded = JSON.parse(readFileSync(handoffCapFile(), 'utf8'));
    return Number.isSafeInteger(recorded.cap) ? `handoff workers: cap ${recorded.cap} (${recorded.source})` : null;
  } catch { return null; }
}

/** Serialize the native queue move and ticket reservation, releasing before any tooling capture. */
export async function withHandoffQueueOrder(work) {
  const lock = await takeResource({ name: 'submit-handoff-order', capacity: 1, scope: 'machine', agent: 'handoff-order' });
  try { return await work(); }
  finally { lock.release(); }
}

/** The machine-wide directory of launches waiting for a worker slot. */
export function handoffQueueDirectory() { return join(machineHome(), 'handoff-queue'); }

/**
 * Take the next place in line, at the submit ordering point and before the slow tooling copy.
 * The place is a monotonic number kept on disk, so ties and clock skew cannot reorder submits.
 *
 * An urgent place is marked in its name, so the dispatcher starts it before every routine one without a board read.
 *
 * @param {string} job - The job id the place belongs to.
 * @param {{ startOf?: (pid: number) => string, urgent?: boolean }} [options] - Process identity and whether the item is urgent.
 * @returns {Promise<string>} The reservation name; pass it to queueHandoffLaunch.
 */
export async function reserveHandoffTicket(job, { startOf = () => '', urgent = false } = {}) {
  const queue = handoffQueueDirectory();
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const lock = await takeResource({ name: 'submit-handoff-ticket', capacity: 1, scope: 'machine', agent: 'handoff-ticket' });
  try {
    const counter = join(queue, 'next-ticket');
    let next = 1;
    try { next = Number(readFileSync(counter, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Number.isSafeInteger(next) || next < 1 || next === Number.MAX_SAFE_INTEGER) throw new Refused('HANDOFF_TICKET_SOURCE', 'restore the durable next-ticket counter before queueing another worker');
    writeFileSync(counter, String(next + 1), { mode: 0o600 });
    const name = `${String(next).padStart(12, '0')}-${job}${urgent ? URGENT_MARK : ''}.reserved`;
    writeFileSync(join(queue, name), JSON.stringify({ pid: process.pid, started: startOf(process.pid) }) + '\n', { mode: 0o600 });
    return name;
  } finally { lock.release(); }
}

/**
 * Fill a reserved place with its launch to start when a slot frees; nothing is spawned here.
 *
 * @param {{ directory: string, tools: string, commonDir: string, job: string, relaunches?: number }} launch - The captured job to start later.
 * @param {string} reservation - The name reserveHandoffTicket returned.
 * @returns {string} The ticket file name.
 */
export function queueHandoffLaunch(launch, reservation) {
  const queue = handoffQueueDirectory();
  rememberQueuedRepository(launch.commonDir);
  const name = reservation.replace(/\.reserved$/u, '.json');
  const draft = join(queue, `.${name}.tmp`);
  writeFileSync(draft, JSON.stringify(launch) + '\n', { mode: 0o600 });
  renameSync(draft, join(queue, name));
  rmSync(join(queue, reservation), { force: true });
  return name;
}

/** Where the repositories that ever queued a launch in this machine home are named, one file each. */
function queuedRepositoriesDirectory() { return join(handoffQueueDirectory(), 'repositories'); }

/**
 * Name a repository as one whose gates queue in this machine home, so its dispatcher sweeps that board after its
 * tickets are gone. Why: a dispatcher sweeps only boards whose gates it runs; on 8 Nov a test dispatcher in a private
 * home swept the real checkout it was started in, relaunched three real gates into that home, and they died on
 * ENOENT when the test removed it (#3850).
 *
 * @param {unknown} commonDir - The launch's Git common directory.
 */
function rememberQueuedRepository(commonDir) {
  if (typeof commonDir !== 'string' || !commonDir) return;
  const directory = queuedRepositoriesDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, createHash('sha256').update(commonDir).digest('hex').slice(0, 32)), commonDir + '\n', { mode: 0o600 });
}

/**
 * The repositories that queued a launch in this machine home and still exist on disk.
 *
 * @returns {string[]}
 */
function queuedRepositories() {
  let names;
  try { names = readdirSync(queuedRepositoriesDirectory()); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const dirs = [];
  for (const name of names) {
    try { const dir = readFileSync(join(queuedRepositoriesDirectory(), name), 'utf8').trim(); if (dir && existsSync(dir)) dirs.push(dir); }
    catch { /* an unreadable entry names no repository; its tickets still name theirs */ }
  }
  return dirs;
}

/**
 * The file a dispatcher holding the machine's lock rewrites on every pass; its age is the liveness check board commands
 * read. Why: reading the lock holders opens the machine's slot database and probes each holder process, which took
 * 4-13 s per command under load; one stat costs about a millisecond, and a stale beat only wakes the full check [C7].
 */
export function handoffDispatcherHeartbeat() { return join(handoffQueueDirectory(), 'dispatcher-heartbeat'); }

/** Rewrite the dispatcher's heartbeat; a missed beat only costs one detached recovery check, never the pass. */
function beatDispatcherHeartbeat() {
  try { writeFileSync(handoffDispatcherHeartbeat(), `${process.pid}\n`, { mode: 0o600 }); }
  catch { /* the next pass beats again */ }
}

/** The dispatcher's own log: its stderr and every slot release it had to retry. */
export function handoffDispatcherLog() { return join(handoffQueueDirectory(), 'dispatcher.log'); }

/**
 * Append one timestamped line to the dispatcher log.
 * Why: the dispatcher runs detached, so a failure it survives is otherwise invisible.
 *
 * @param {string} line - What happened, without a trailing newline.
 */
function logDispatcher(line) {
  try { appendFileSync(handoffDispatcherLog(), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); }
  catch { /* A log that cannot be written must not stop dispatch; the retry itself still happens. */ }
}

/** Release one exited worker's slot with a single lock attempt; the dispatcher retries on its next pass. */
function releaseOnce(slot) { slot.release({ retryMs: 0 }); }

/**
 * Release the slot of every worker that has exited, keeping a worker whose release failed for the next pass.
 * Why: on 4 Nov a SLOT_DB_LOCKED thrown inside the worker's exit handler killed the dispatcher at its first exit.
 *
 * @param {Map<object, { slot: object, job: string, exited: boolean }>} running - Live and exited workers by process.
 * @param {(slot: object) => void} releaseSlot - Frees one slot or throws.
 */
function releaseExited(running, releaseSlot) {
  for (const [worker, entry] of running) {
    if (!entry.exited) continue;
    try { releaseSlot(entry.slot); running.delete(worker); }
    catch (error) { logDispatcher(`slot release for ${entry.job} failed: ${error?.code ?? 'ERROR'} ${error?.message ?? error}; retrying on the next pass`); }
  }
}

/**
 * Wait for every worker this dispatcher started to exit, freeing each one's slot as it does: a dispatcher that hands
 * the machine over launches nothing more but still frees the slots of the gates it started (DJ16).
 *
 * @param {Map<unknown, { exited?: boolean, slot: object, job: string }>} running - The workers this dispatcher started.
 * @param {{ pollMs?: number, releaseSlot?: (slot: object) => void }} [options]
 * @returns {Promise<void>}
 */
export async function finishRunningWorkers(running, { pollMs = 500, releaseSlot = releaseOnce } = {}) {
  releaseExited(running, releaseSlot);
  while (running.size) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    releaseExited(running, releaseSlot);
  }
}

/**
 * Whether any worker this dispatcher started has exited without writing a result since it started; each exit is
 * counted once. Why: the dispatcher sees its own worker's exit at once, so it need not wait for a timed sweep to learn
 * of a death; on 8 Nov dead gates waited 22 min (p50) for their retry [C7].
 *
 * @param {Map<unknown, { exited: boolean, directory: string, startedAt: number, resultAt: number | null, deathSeen?: boolean }>} running
 * @returns {boolean}
 */
export function exitedWithoutResult(running) {
  let found = false;
  for (const entry of running.values()) {
    if (!entry.exited || entry.deathSeen) continue;
    entry.deathSeen = true;
    let at = entry.resultAt;
    try { at ??= resultWrittenAt(entry.directory, entry.startedAt); } catch { at = null; }
    if (at === null) found = true;
  }
  return found;
}

/** The name mark of a ticket whose item is urgent. */
const URGENT_MARK = '.urgent';

/**
 * Places in line: urgent tickets first, then routine ones, each lowest number first; reservations count so a slow
 * submit keeps its turn. Why urgent first: an unblocking fix must not wait behind routine resubmits (#3062).
 */
function waitingTickets() {
  const urgent = name => name.replace(/\.(json|reserved)$/u, '').endsWith(URGENT_MARK);
  try { return readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)).sort().sort((a, b) => Number(urgent(b)) - Number(urgent(a))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/**
 * Whether a job still holds a place in line, reserved or filled. Why: a queued job with neither a place nor a worker
 * record will never start, so the health sweep may end it instead of leaving its claim held for hours (#3121, #3153).
 *
 * @param {string} job - The job id the place would belong to.
 * @returns {boolean}
 */
export function handoffTicketWaiting(job) {
  return waitingTickets().some(name => name.replace(/\.(json|reserved)$/u, '').replace(/\.urgent$/u, '').replace(/^\d+-/u, '') === job);
}

/**
 * Remove a job's place in line, reserved or filled, so the dispatcher never starts it.
 *
 * @param {string} job - The job id the place belongs to.
 * @returns {number} How many place files were removed.
 */
export function dropHandoffTicket(job) {
  let removed = 0;
  for (const name of waitingTickets()) {
    if (name.replace(/\.(json|reserved)$/u, '').replace(/\.urgent$/u, '').replace(/^\d+-/u, '') !== job) continue;
    rmSync(join(handoffQueueDirectory(), name), { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Whether any place in line waits, reserved or filled, for any repository on this machine.
 * Why: a dispatcher that freed its board row after its last ticket check must look once more, because a submit that
 * saw the row still held queued its ticket without launching a dispatcher (#3495).
 *
 * @returns {boolean}
 */
export function handoffTicketsWaiting() {
  return waitingTickets().length > 0;
}

/** A reservation whose submitting process died gives up its place. */
function reservationAbandoned(name, startOf) {
  const file = join(handoffQueueDirectory(), name);
  let owner;
  try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  try {
    process.kill(owner.pid, 0);
    const observed = startOf(owner.pid);
    if (!owner.started || !observed || owner.started === observed) return false;
  } catch (error) { if (error.code !== 'ESRCH') return false; }
  rmSync(file, { force: true });
  return true;
}

/**
 * The repositories whose launches wait in line: each ticket names its Git common directory.
 * Why: the drain sweeps these boards for hand-offs whose worker is gone before it starts anything (#3221).
 */
function waitingCommonDirs() {
  const dirs = new Set();
  for (const name of waitingTickets()) {
    if (!name.endsWith('.json')) continue;
    try { const launch = JSON.parse(readFileSync(join(handoffQueueDirectory(), name), 'utf8')); if (typeof launch.commonDir === 'string') dirs.add(launch.commonDir); }
    catch { /* a ticket that cannot be read is reported when it is dispatched */ }
  }
  return [...dirs];
}

/**
 * Run the caller's sweep once for each repository that queued a launch in this machine home, waiting or not. The
 * directory the dispatcher started in is never swept for that alone: a dispatcher in another home must not recover
 * this home's gates into its own (#3850). A failed sweep is logged and never stops dispatch; it never rejects, so it
 * may run beside the dispatch loop.
 *
 * @param {((commonDir: string) => Promise<void> | void) | undefined} sweep - Ends hand-offs whose worker is gone in one repository.
 */
async function sweepGoneHandoffs(sweep) {
  if (!sweep) return;
  for (const commonDir of new Set([...queuedRepositories(), ...waitingCommonDirs()])) {
    try { await sweep(commonDir); }
    catch (error) { logDispatcher(`worker-gone sweep of ${commonDir} failed: ${error?.code ?? 'ERROR'} ${error?.message ?? error}; it runs again on a later pass`); }
  }
}

/**
 * How often a dispatcher that stays busy sweeps again for hand-offs whose worker is gone [C7,#3450]. A worker this
 * dispatcher started is swept the moment it exits; this bound covers workers an earlier dispatcher started.
 */
export const HANDOFF_SWEEP_EVERY_MS = 15_000;

/**
 * A sweep that runs once at the start of a drain and again, in the background, at most every `everyMs` while it lasts.
 * Why: a drain lasts as long as any worker runs, so on 7 Nov one failed sweep at its start was never retried and two
 * gates read running with no worker for hours (#3450). At most one sweep runs at a time, and a slow one never holds up launches.
 *
 * @param {((commonDir: string) => Promise<void> | void) | undefined} sweep - Ends hand-offs whose worker is gone in one repository.
 * @param {number} everyMs - The least time between the starts of two sweeps.
 * `soon` starts a sweep at once or, while one runs, one more right after it, so a worker that just exited is swept
 * within seconds rather than at the next `everyMs`.
 *
 * @returns {{ now: () => Promise<void>, due: () => void, soon: () => void, settled: () => Promise<void> }} Run now, start
 *   one if due, start one as soon as none runs, and wait for the ones in flight.
 */
export function repeatingSweep(sweep, everyMs) {
  let startedAt = 0;
  let running = null;
  let again = false;
  /** Start one sweep and remember it until it ends; a sweep asked for while it ran starts right after it. */
  const start = () => {
    startedAt = Date.now();
    again = false;
    running = sweepGoneHandoffs(sweep).finally(() => { running = null; if (again) start(); });
    return running;
  };
  return {
    now: () => start(),
    due() { if (sweep && !running && Date.now() - startedAt >= everyMs) start(); },
    soon() { if (!sweep) return; if (running) again = true; else start(); },
    async settled() { while (running) await running; },
  };
}

/**
 * The admission that records each gate's driver on its board before and after the dispatcher starts it. The default
 * records nothing, for a dispatcher run without a board (its own tests); apps/lib/src/io/handoff/dispatcher.js passes the
 * drive cell's admission, which writes the gate's drive job [C7].
 */
const NO_ADMISSION = Object.freeze({ admit() {}, spawned() {}, unstarted() {}, entry: null });

/** The driver entry inside a captured tools tree: the drive cell's gate driver. */
function driverEntry(tools) { return join(realpathSync(tools), 'apps/cli/src/io/gate/drive.js'); }

/**
 * Start one captured gate's driver detached from the dispatcher's terminal: admit the gate to a fresh driver id on its
 * board, start the drive cell's gate driver from the captured tools, then record the process it started. Nothing
 * is written beside the hand-off; the drive job is the gate's record of who drives it [C7].
 * Why the dispatcher's own entry for an older snapshot: a gate queued before its tools had the gate driver still runs.
 */
async function startWorker(launch, relaunches, startOf, admission = NO_ADMISSION) {
  const owner = `gate-driver:${launch.job}:${randomUUID()}`;
  // An admission that cannot be written starts nothing: the ticket keeps its place for the next pass.
  try { admission.admit(launch, { owner, relaunches }); }
  catch (error) { throw Object.assign(error, { owner, admission: true }); }
  let log;
  try {
    log = openSync(join(launch.directory, 'worker.log'), 'a', 0o600);
    const entry = driverEntry(launch.tools);
    const worker = spawn(process.execPath, [!existsSync(entry) && admission.entry ? admission.entry : entry, join(launch.directory, 'request.json'), owner],
      // stdin is the worker's lifeline: the pipe closes when this dispatcher exits, however it exits (#3899).
      { cwd: launch.commonDir, detached: true, stdio: ['pipe', log, log], env: { ...handoffProcessEnvironment(), [HANDOFF_WORKER_LIFELINE_ENV]: '1' } });
    await once(worker, 'spawn');
    try { admission.spawned(launch, { owner, pid: worker.pid, started: startOf(worker.pid) }); }
    catch (error) {
      const closed = once(worker, 'close'); worker.kill('SIGTERM'); await closed; throw Object.assign(error, { owner });
    }
    return worker;
  } catch (error) { throw Object.assign(error, { owner }); }
  finally { if (log !== undefined) closeSync(log); }
}

/**
 * A gate whose driver cannot start, most often because temp cleanup removed its captured tools, gets an unstarted
 * record on its drive job, so the health sweep ends its job as infrastructure, never a builder red; the dispatcher
 * then carries on with the next ticket. Why: on 4 Nov one missing tools folder stopped the dispatcher, and 100 of
 * 142 queued gates sat behind it. A ticket whose record cannot be written is kept aside, hidden, as evidence.
 */
function endUnstarted(file, name, launch, error, admission = NO_ADMISSION) {
  const reason = { code: error.code ?? 'HANDOFF_WORKER_START', message: error.message };
  try {
    admission.unstarted(launch, { owner: error.owner ?? null, ...reason });
    rmSync(file, { force: true });
    process.stderr.write(`[HANDOFF_WORKER_START] queued worker ${launch.job} could not start (${error.message}); its gate ends as infrastructure\n`);
  } catch (record) {
    try { renameSync(file, join(handoffQueueDirectory(), `.${name}.unstarted`)); }
    catch { rmSync(file, { force: true }); /* a ticket that can be neither kept nor recorded still never blocks the queue */ }
    process.stderr.write(`[HANDOFF_WORKER_START] queued worker ${launch.job} could not start (${error.message}) or be recorded (${record.message}); its ticket is kept aside\n`);
  }
}

/**
 * Start queued workers oldest first, never more than the cap at once, until the queue is empty and all have exited.
 * Each running worker holds one slot of the machine resource pool, so the count is the pool's own.
 * Returns at once when another dispatcher already holds the machine.
 *
 * @param {{ capacity?: number | (() => number), pollMs?: number, releaseSlot?: (slot: object) => void, takeSlot?: Function, stallMs?: number }} [options] - The cap, or a
 *   function read again on every pass so a running dispatcher picks up a raised cap without a restart, how often new tickets
 *   are noticed, how an exited worker's slot is freed (a throw is logged and retried on the next pass), how to take a worker slot, how long
 *   an idle dispatcher with queued tickets waits before it logs why it launched nothing, and a
 *   sweep run on each drain for every repository with work in line, which requeues hand-offs whose worker is gone, and
 *   how often a drain that stays busy runs that sweep again (sweepEveryMs), the admission that records each gate's
 *   driver on its board (the drive cell's, from apps/lib/src/io/handoff/dispatcher.js), onPass, run once a pass to renew
 *   the dispatcher's job row, and `running`, the workers this dispatcher started, kept across drains so a drain retried
 *   after a transient failure still frees each of their slots when it exits.
 * @returns {Promise<{ started: string[], deferred?: true }>} Jobs this dispatcher started, in order; deferred when another
 *   dispatcher held the machine, which then drains every repository's tickets.
 */
export async function drainHandoffQueue({ capacity = handoffWorkerCapacity(), pollMs = 500, startOf = () => '', resultGraceMs = HANDOFF_RESULT_GRACE_MS, releaseSlot = releaseOnce, takeSlot = takeResource, stallMs = HANDOFF_LAUNCH_STALL_MS, sweep, sweepEveryMs = HANDOFF_SWEEP_EVERY_MS, admission = NO_ADMISSION, onPass = () => {}, running = new Map() } = {}) {
  reuseResourceConnections(); // One connection per process for every slot call below, so passes never leak handles [C7,#3338].
  const started = [];
  const sweeps = repeatingSweep(sweep, sweepEveryMs);
  let existing;
  try { existing = listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_WORKER_RESOURCE)?.capacity; }
  catch (error) { if (!RETRIED_SLOT_ERRORS.has(error.code)) throw error; logDispatcher(`worker pool unreadable at start: ${error.code}; using the cap alone`); }
  // Existing machine capacity can come from an explicit operator override or a prior
  // dispatcher run. Keep it while holders may depend on those slots; takeResource
  // supports safe growth but intentionally refuses an implicit shrink.
  // A function cap is re-read on every pass, so the join is a function too: Math.max on a function is NaN and the take refuses [C7,#3302].
  const effectiveCapacity = typeof capacity === 'function'
    ? () => { const wanted = capacity(); return Math.max(wanted, existing ?? wanted); }
    : Math.max(capacity, existing ?? capacity);
  for (;;) {
    let lock;
    try {
      lock = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'handoff-dispatcher', loopHeartbeat: true,
        onWait() { throw new Refused('HANDOFF_DISPATCHER_RUNNING', 'another dispatcher is starting the queued workers'); } });
    } catch (error) {
      if (error.code === 'HANDOFF_DISPATCHER_RUNNING') return { started, deferred: true };
      // A locked slot database must not end a dispatcher that has tickets to start: wait a pass and take the lock again [C7,#3326].
      if (RETRIED_SLOT_ERRORS.has(error.code)) { logDispatcher(`dispatcher lock not taken: ${error.code}; retrying on the next pass`); await new Promise(done => setTimeout(done, pollMs)); if (!waitingTickets().length) return { started }; continue; }
      throw error;
    }
    beatDispatcherHeartbeat();
    // Every drain first ends and requeues hand-offs whose worker is gone, so no gate shows running for hours (#3221).
    // A busy drain sweeps again every sweepEveryMs, so a failed sweep is retried while workers still run (#3450).
    await sweeps.now();
    try { await dispatchWhileQueued(effectiveCapacity, pollMs, started, startOf, resultGraceMs, releaseSlot, takeSlot, stallMs, lock, sweeps, admission, onPass, running); }
    finally { await sweeps.settled(); lock.release(); }
    // A ticket written while the lock was being released still needs a dispatcher.
    if (!waitingTickets().length) return { started };
  }
}

/** When this worker run wrote its green (submission.json) or red (refusal.json) result, or null while it has none. */
function resultWrittenAt(directory, since) {
  for (const name of ['submission.json', 'refusal.json']) {
    try { const at = statSync(join(directory, name)).mtimeMs; if (at >= since) return at; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

/**
 * Signal a detached worker's whole process group, so its --execute child stops with it. A group that is gone (ESRCH) or
 * that this dispatcher may not signal (EPERM, a pid since reused by another user's process) is logged and treated as no
 * longer this dispatcher's worker; it is never thrown. Why: on 8 Nov a kill EPERM thrown from here ended the dispatcher
 * twice (09:08Z and 09:16Z), each time followed by dead gates (#3727) [C7].
 *
 * @param {{ pid: number }} worker - The detached worker whose group is signalled.
 * @param {string} signal - The signal to send.
 * @param {{ kill?: (pid: number, signal: string) => void, entry?: { job?: string, foreign?: boolean } }} [options] - The kill call (tests pass a stand-in) and the running entry to mark.
 * @returns {boolean} True when the signal was sent.
 */
export function signalWorker(worker, signal, { kill = process.kill, entry } = {}) {
  try { kill(-worker.pid, signal); return true; }
  catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
    if (entry) entry.foreign = true;
    if (error.code === 'EPERM') logDispatcher(`signal ${signal} to the worker group of ${entry?.job ?? worker.pid} refused: ${error.code}; treated as not this dispatcher's worker`);
    return false;
  }
}

/**
 * Stop a worker that outlived its recorded result by the grace, then kill its group if it does not close.
 * Why: on 4 Nov a worker whose green was recorded waited on a dead runner until runnerWaitMs, holding its slot
 * while 49 tickets queued; nothing it does after the result can change the verdict [C7,#2988].
 */
function boundAfterResult(entry, now, graceMs) {
  entry.resultAt ??= resultWrittenAt(entry.directory, entry.startedAt);
  if (entry.foreign || entry.resultAt === null || now - entry.resultAt < graceMs) return;
  if (!entry.stoppedAt) { entry.stoppedAt = now; signalWorker(entry.worker, 'SIGTERM', { entry }); }
  else if (now - entry.stoppedAt >= HANDOFF_STOP_KILL_MS) signalWorker(entry.worker, 'SIGKILL', { entry });
}

/** Sweep finished handoff folders, sparing every job that waits or runs; a failed sweep never stops dispatch. */
function sweepFinished(running) {
  try {
    const protect = new Set([...running.values()].map(entry => entry.job));
    for (const name of waitingTickets()) protect.add(name.replace(/\.(json|reserved)$/u, '').replace(/\.urgent$/u, '').replace(/^\d+-/u, ''));
    pruneFinishedHandoffs(handoffRoots(), { protect });
  } catch (error) { logDispatcher(`handoff folder sweep failed: ${error?.message ?? error}`); }
}

/** How long a dispatcher with queued tickets and no running worker may launch nothing before it logs why [C7,#3326]. */
export const HANDOFF_LAUNCH_STALL_MS = 120_000;

/** Slot-pool errors that only mean "not this pass": the dispatcher logs them and tries again on its next pass [C7,#3326]. */
const RETRIED_SLOT_ERRORS = new Set(['SLOT_DB_LOCKED', 'BAD_RESOURCE_CAPACITY']);

/**
 * The worker cap for this pass; a capacity that throws or is not a whole number of 1 or more falls back to the local cap.
 * Why: a bad capacity read must cost one pass at most, never the launching itself [C7,#3326].
 */
function passCapacity(capacity) {
  try {
    const cap = typeof capacity === 'function' ? capacity() : capacity;
    if (Number.isSafeInteger(cap) && cap >= 1) return cap;
    logDispatcher(`worker cap ${String(cap)} is not a whole number of 1 or more; using the local cap for this pass`);
  } catch (error) { logDispatcher(`worker cap unreadable: ${error?.code ?? 'ERROR'} ${error?.message ?? error}; using the local cap for this pass`); }
  return handoffWorkerCapacity({ env: {} });
}

/**
 * Hold the dispatcher lock, filling free slots from the oldest tickets, until nothing waits or runs.
 * The lock is renewed once per pass and nowhere else: a wedged loop stops renewing, its lock goes stale and the
 * next submit starts a fresh dispatcher [C7,#2990].
 */
async function dispatchWhileQueued(capacity, pollMs, started, startOf, resultGraceMs, releaseSlot, takeSlot = takeResource, stallMs = HANDOFF_LAUNCH_STALL_MS, lock, sweeps = { due() {}, soon() {} }, admission = NO_ADMISSION, onPass = () => {}, running = new Map()) {
  let wake = () => {};
  let lastLaunchAt = Date.now();
  let lastError = 'none';
  let prunedAt = 0;
  while (waitingTickets().length || running.size) {
    // A locked slot database costs this renewal only: the lease is freed only when this process ends, never by age, so
    // a missed renewal loses nothing, and the next pass renews again. Why: on 8 Nov a renewal that met a 10 s lock
    // ended the dispatcher six times in 95 minutes (#3717) [C7].
    try { lock.renew(); }
    catch (error) {
      if (!RETRIED_SLOT_ERRORS.has(error?.code)) throw error;
      logDispatcher(`dispatcher lock not renewed: ${error.code} ${error.message}; retrying on the next pass`);
    }
    beatDispatcherHeartbeat();
    // The dispatcher's job row is renewed from here too, so a wedged loop stops renewing both (#2990).
    // A pass that asks to hand the machine over (a dispatcher on stale tooling) ends the drain; any other failure is logged.
    try { onPass(); } catch (error) { if (error?.handOver) throw error; logDispatcher(`dispatcher row not renewed: ${error?.code ?? 'ERROR'} ${error?.message ?? error}`); }
    // Finished folders are swept from this loop, at most once a minute; queued and running jobs are spared [C7,#3292].
    if (Date.now() - prunedAt >= 60_000) { prunedAt = Date.now(); sweepFinished(running); }
    // A worker that exited with no result is a dead gate: sweep now, so its gate ends and its retry starts in seconds.
    if (exitedWithoutResult(running)) sweeps.soon();
    sweeps.due();
    releaseExited(running, releaseSlot);
    for (const entry of running.values()) boundAfterResult(entry, Date.now(), resultGraceMs);
    const cap = passCapacity(capacity);
    const queued = waitingTickets().length;
    if (running.size) lastLaunchAt = Date.now();
    else if (queued && Date.now() - lastLaunchAt >= stallMs) {
      logDispatcher(`no worker launched for ${Math.round((Date.now() - lastLaunchAt) / 1000)}s with ${queued} queued and cap ${cap}; last slot error ${lastError}; launching on this pass`);
      lastLaunchAt = Date.now();
    }
    for (const name of waitingTickets()) {
      // A live reservation holds its place: later submits wait behind it.
      if (name.endsWith('.reserved')) { if (reservationAbandoned(name, startOf)) continue; break; }
      let slot;
      try {
        slot = await takeSlot({ name: HANDOFF_WORKER_RESOURCE, capacity: cap, scope: 'machine', agent: 'handoff-worker', kind: 'submit-handoff', allowCapacityGrowth: true, allowCapacityShrink: true,
          onWait() { throw new Refused('HANDOFF_WORKERS_FULL', 'every worker slot is busy'); } });
      } catch (error) {
        if (error.code === 'HANDOFF_WORKERS_FULL') break;
        if (RETRIED_SLOT_ERRORS.has(error.code)) { lastError = error.code; logDispatcher(`worker slot not taken: ${error.code} ${error.message}; retrying on the next pass`); break; }
        throw error;
      }
      const file = join(handoffQueueDirectory(), name);
      let launch;
      try { launch = JSON.parse(readFileSync(file, 'utf8')); }
      catch (error) { slot.release(); throw new Refused('HANDOFF_QUEUE_SOURCE', `cannot read queued worker ${name}: ${error.message}; restore its ticket before dispatch`); }
      let worker;
      const startedAt = Date.now();
      try { worker = await startWorker(launch, launch.relaunches ?? 0, startOf, admission); }
      catch (error) {
        slot.release();
        // A gate whose last driver's lease is still live waits in line until that lease ends or lapses (2 minutes).
        if (error.code === 'GATE_DRIVE_LEASED') continue;
        // A board that could not record the admission keeps the ticket in line for the next pass; a stale gate never will serve, so it ends unstarted.
        if (error.admission && error.code !== 'GATE_STALE') { lastError = error.code ?? 'ERROR'; logDispatcher(`gate ${launch.job} not admitted: ${error.code ?? 'ERROR'} ${error.message}; retrying on the next pass`); break; }
        endUnstarted(file, name, launch, error, admission); continue;
      }
      rmSync(file);
      // The worker holds its own slot from here: a dispatcher that exits for any reason leaves it held while the worker
      // runs and freed when the worker ends, so a successor never starts a second set of workers beside the running ones.
      try { if (!slot.handOver?.(worker.pid)) logDispatcher(`worker ${launch.job} slot kept by the dispatcher: the worker's start identity is unreadable`); }
      catch (error) { logDispatcher(`worker ${launch.job} slot kept by the dispatcher: ${error?.code ?? 'ERROR'} ${error?.message ?? error}`); }
      lastLaunchAt = Date.now();
      rememberHandoffRoot(launch.directory);
      started.push(launch.job);
      const entry = { slot, job: launch.job, exited: false, worker, directory: launch.directory, startedAt, resultAt: null, stoppedAt: 0 };
      running.set(worker, entry);
      // The exit handler only marks and wakes: the release runs in the loop, where a failure is caught and retried.
      worker.once('close', () => { entry.exited = true; wake(); });
    }
    await new Promise(done => { wake = done; setTimeout(done, pollMs); });
  }
}

/** Whether a live dispatcher holds the machine's dispatcher lock. */
function dispatcherHeld() {
  return Boolean(listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_DISPATCHER_RESOURCE)?.holders?.length);
}

/** The environment variable that names the dispatcher's job-row lease owner to the dispatcher it launches. */
export const HANDOFF_DISPATCHER_OWNER_ENV = 'PULLBOARD_DISPATCHER_OWNER';

/**
 * Make sure a dispatcher is running; spawn one from the captured tooling whenever none holds the machine's lock.
 * Why: the lock holder is the only proof of a working dispatcher. On 4 Nov a receipt with a live pid and an empty
 * start time kept a wedged dispatcher trusted while the queue sat; an extra spawn only exits when the lock is held.
 * The caller took the board's dispatcher row for `owner` (the drive cell's ensureDispatcher); the launched dispatcher
 * renews that row under the same owner [C7].
 *
 * @param {string} tools - A captured tooling snapshot that contains this module.
 * @param {string} cwd - Directory for the dispatcher process.
 * @param {{ startOf?: (pid: number) => string, owner?: string }} [options]
 * @returns {Promise<boolean>} True when this call launched a dispatcher; false when a live one already holds the machine or another launcher holds the launch lock, which this call never waits for.
 */
export async function ensureHandoffDispatcher(tools, cwd, { startOf = () => '', owner } = {}) {
  if (dispatcherHeld()) return false;
  // Another launcher already holds the lock and is starting the dispatcher this call would start, so this call never queues
  // behind it. Why: on 8 Nov ~77 board commands waited on this lock with no deadline, each poll a turn in the single-writer
  // queue, and builders idled 20 minutes behind a 14-minute commit hook [C7].
  let lock;
  try {
    lock = await takeResource({ name: 'submit-handoff-dispatcher-launch', capacity: 1, scope: 'machine', agent: 'handoff-dispatcher-launch',
      onWait() { throw new Refused('HANDOFF_LAUNCH_BUSY', 'another process is launching the dispatcher'); } });
  } catch (error) {
    if (error.code === 'HANDOFF_LAUNCH_BUSY') return false;
    throw error;
  }
  try {
    if (dispatcherHeld()) return false;
    const queue = handoffQueueDirectory();
    mkdirSync(queue, { recursive: true, mode: 0o700 });
    const receipt = join(queue, 'dispatcher.json');
    const entry = join(realpathSync(tools), 'apps/lib/src/io/handoff/dispatcher.js');
    const detachedLauncher = join(realpathSync(tools), 'packages/resources/src/io/handoff/worker/detach.js');
    const env = handoffDispatcherEnvironment(process.env);
    if (owner) env[HANDOFF_DISPATCHER_OWNER_ENV] = owner;
    const launcher = spawn(process.execPath, [detachedLauncher, JSON.stringify({ entry, cwd, env, log: handoffDispatcherLog() })], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const output = [];
    const errors = [];
    launcher.stdout.on('data', chunk => output.push(chunk));
    launcher.stderr.on('data', chunk => errors.push(chunk));
    await once(launcher, 'spawn');
    const [code, signal] = await once(launcher, 'close');
    if (code !== 0) throw new Error(Buffer.concat(errors).toString('utf8').trim() || `detached launcher exited ${signal ?? code}`);
    const pid = Number(Buffer.concat(output).toString('utf8').trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('detached launcher did not report its dispatcher pid');
    try { writeFileSync(receipt, JSON.stringify({ pid, started: startOf(pid) }) + '\n', { mode: 0o600 }); }
    catch (error) {
      try { process.kill(pid, 'SIGTERM'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
      throw error;
    }
    return true;
  } finally { lock.release(); }
}
