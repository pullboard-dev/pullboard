/** At most N submit-handoff workers run on the machine at once; the rest wait unspawned in submit order [C7]. */
import { availableParallelism } from 'node:os';
import {
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
import { once } from 'node:events';
import { join } from 'node:path';
import {
  listResources,
  takeResource,
} from './resources.js';
import { machineHome } from './machine-home.js';
import { Refused } from '../../../kernel/index.js';

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

/**
 * Count of handoff workers allowed at once, with where the number came from: the override when set, else the cores up
 * to a default of 4, raised to one worker per five registered runner slots, or to every runner slot when
 * gate.runnersOnly is on. Why: a handoff worker mostly waits on a remote runner, so on 3 Nov a cap of 4 left 69
 * submits queued while 42 of 54 runner slots sat idle, and on 4 Nov 51-60 gates queued behind 12 workers while 63
 * runner slots existed.
 *
 * @param {{ env?: object, cores?: number, runnerSlots?: number, runnersOnly?: boolean }} [options] - Environment, core count, total registered runner slots and whether checks run only on runners.
 * @returns {{ cap: number, source: string }} A positive whole number and its origin, for the status line.
 */
export function handoffWorkerCapacityDetail({ env = process.env, cores = availableParallelism(), runnerSlots = 0, runnersOnly = false } = {}) {
  const raw = env[HANDOFF_WORKER_CAP_ENV];
  if (raw !== undefined && raw !== '') {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Refused('BAD_HANDOFF_WORKER_CAP', `${HANDOFF_WORKER_CAP_ENV} must be a whole number of 1 or more; unset it for the default`);
    return { cap: value, source: `${HANDOFF_WORKER_CAP_ENV} override` };
  }
  const local = Math.max(1, Math.min(4, cores));
  if (!Number.isSafeInteger(runnerSlots) || runnerSlots < 1) return { cap: local, source: `local cores (${cores})` };
  const shared = runnersOnly ? runnerSlots : Math.floor(runnerSlots / 5);
  if (shared > local) return { cap: shared, source: runnersOnly ? `every runner slot (${runnerSlots}, gate.runnersOnly)` : `one per five runner slots (${runnerSlots})` };
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
  const name = reservation.replace(/\.reserved$/u, '.json');
  const draft = join(queue, `.${name}.tmp`);
  writeFileSync(draft, JSON.stringify(launch) + '\n', { mode: 0o600 });
  renameSync(draft, join(queue, name));
  rmSync(join(queue, reservation), { force: true });
  return name;
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

/** Start one captured worker detached from the dispatcher's terminal, keeping its incarnation on disk. */
async function startWorker(launch, relaunches, startOf) {
  const log = openSync(join(launch.directory, 'worker.log'), 'a', 0o600);
  try {
    const worker = spawn(process.execPath, [join(realpathSync(launch.tools), 'apps', 'lib', 'src', 'shell', 'submit-handoff-worker.js'), join(launch.directory, 'request.json')],
      { cwd: launch.commonDir, detached: true, stdio: ['ignore', log, log], env: { ...process.env } });
    await once(worker, 'spawn');
    try { writeFileSync(join(launch.directory, 'worker.json'), JSON.stringify({ version: 1, job: launch.job, pid: worker.pid, started: startOf(worker.pid), relaunches }) + '\n', { mode: 0o600 }); }
    catch (error) {
      const closed = once(worker, 'close'); worker.kill('SIGTERM'); await closed; throw error;
    }
    return worker;
  } finally { closeSync(log); }
}

/**
 * A worker that cannot start, most often because temp cleanup removed its captured tools, leaves an unstarted record
 * where its worker record would be, so the health sweep ends its job as infrastructure, never a builder red; the
 * dispatcher then carries on with the next ticket. Why: on 4 Nov one missing tools folder stopped the dispatcher, and
 * 100 of 142 queued gates sat behind it. A ticket whose record cannot be written is kept aside, hidden, as evidence.
 */
function endUnstarted(file, name, launch, error) {
  const reason = { code: error.code ?? 'HANDOFF_WORKER_START', message: error.message };
  try {
    writeFileSync(join(launch.directory, 'worker.json'), JSON.stringify({ version: 1, job: launch.job, pid: null, started: null,
      relaunches: launch.relaunches ?? 0, unstarted: reason }) + '\n', { mode: 0o600 });
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
 * @param {{ capacity?: number | (() => number), pollMs?: number }} [options] - The cap, or a function read again on every
 *   pass so a running dispatcher picks up a raised cap without a restart, and how often new tickets are noticed.
 * @returns {Promise<{ started: string[] }>} Jobs this dispatcher started, in order.
 */
export async function drainHandoffQueue({ capacity = handoffWorkerCapacity(), pollMs = 500, startOf = () => '', resultGraceMs = HANDOFF_RESULT_GRACE_MS } = {}) {
  const started = [];
  for (;;) {
    let lock;
    try {
      lock = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'handoff-dispatcher',
        onWait() { throw new Refused('HANDOFF_DISPATCHER_RUNNING', 'another dispatcher is starting the queued workers'); } });
    } catch (error) {
      if (error.code === 'HANDOFF_DISPATCHER_RUNNING') return { started };
      throw error;
    }
    try { await dispatchWhileQueued(capacity, pollMs, started, startOf, resultGraceMs); }
    finally { lock.release(); }
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

/** Signal a detached worker's whole process group, so its --execute child stops with it; a gone group is fine. */
function signalWorker(worker, signal) {
  try { process.kill(-worker.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

/**
 * Stop a worker that outlived its recorded result by the grace, then kill its group if it does not close.
 * Why: on 4 Nov a worker whose green was recorded waited on a dead runner until runnerWaitMs, holding its slot
 * while 49 tickets queued; nothing it does after the result can change the verdict [C7,#2988].
 */
function boundAfterResult(entry, now, graceMs) {
  entry.resultAt ??= resultWrittenAt(entry.directory, entry.startedAt);
  if (entry.resultAt === null || now - entry.resultAt < graceMs) return;
  if (!entry.stoppedAt) { entry.stoppedAt = now; signalWorker(entry.worker, 'SIGTERM'); }
  else if (now - entry.stoppedAt >= HANDOFF_STOP_KILL_MS) signalWorker(entry.worker, 'SIGKILL');
}

/** Hold the dispatcher lock, filling free slots from the oldest tickets, until nothing waits or runs. */
async function dispatchWhileQueued(capacity, pollMs, started, startOf, resultGraceMs) {
  const running = new Map();
  let wake = () => {};
  while (waitingTickets().length || running.size) {
    for (const entry of running.values()) boundAfterResult(entry, Date.now(), resultGraceMs);
    const cap = typeof capacity === 'function' ? capacity() : capacity;
    for (const name of waitingTickets()) {
      // A live reservation holds its place: later submits wait behind it.
      if (name.endsWith('.reserved')) { if (reservationAbandoned(name, startOf)) continue; break; }
      let slot;
      try {
        slot = await takeResource({ name: HANDOFF_WORKER_RESOURCE, capacity: cap, scope: 'machine', agent: 'handoff-worker', kind: 'submit-handoff', allowCapacityGrowth: true, allowCapacityShrink: true,
          onWait() { throw new Refused('HANDOFF_WORKERS_FULL', 'every worker slot is busy'); } });
      } catch (error) {
        if (error.code === 'HANDOFF_WORKERS_FULL') break;
        throw error;
      }
      const file = join(handoffQueueDirectory(), name);
      let launch;
      try { launch = JSON.parse(readFileSync(file, 'utf8')); }
      catch (error) { slot.release(); throw new Refused('HANDOFF_QUEUE_SOURCE', `cannot read queued worker ${name}: ${error.message}; restore its ticket before dispatch`); }
      let worker;
      const startedAt = Date.now();
      try { worker = await startWorker(launch, launch.relaunches ?? 0, startOf); }
      catch (error) { slot.release(); endUnstarted(file, name, launch, error); continue; }
      rmSync(file);
      started.push(launch.job);
      running.set(worker, { worker, directory: launch.directory, startedAt, resultAt: null, stoppedAt: 0 });
      worker.once('close', () => { running.delete(worker); slot.release(); wake(); });
    }
    await new Promise(done => { wake = done; setTimeout(done, pollMs); });
  }
}

/**
 * Make sure a dispatcher is running; spawn one from the captured tooling only when none holds the machine.
 *
 * @param {string} tools - A captured tooling snapshot that contains this module.
 * @param {string} cwd - Directory for the dispatcher process.
 */
export async function ensureHandoffDispatcher(tools, cwd, { startOf = () => '' } = {}) {
  const held = listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_DISPATCHER_RESOURCE);
  if (held?.holders?.length) return;
  const lock = await takeResource({ name: 'submit-handoff-dispatcher-launch', capacity: 1, scope: 'machine', agent: 'handoff-dispatcher-launch' });
  try {
    const queue = handoffQueueDirectory();
    mkdirSync(queue, { recursive: true, mode: 0o700 });
    const receipt = join(queue, 'dispatcher.json');
    let previous;
    try { previous = JSON.parse(readFileSync(receipt, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous?.pid) {
      try {
        process.kill(previous.pid, 0);
        const observed = startOf(previous.pid);
        if (!previous.started || !observed || previous.started === observed) return;
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const entry = join(realpathSync(tools), 'bin', 'handoff-worker-dispatcher.js');
    const dispatcher = spawn(process.execPath, [entry], { cwd, detached: true, stdio: 'ignore', env: { ...process.env } });
    await once(dispatcher, 'spawn');
    try { writeFileSync(receipt, JSON.stringify({ pid: dispatcher.pid, started: startOf(dispatcher.pid) }) + '\n', { mode: 0o600 }); }
    catch (error) { const closed = once(dispatcher, 'close'); dispatcher.kill('SIGTERM'); await closed; throw error; }
    dispatcher.unref();
  } finally { lock.release(); }
}
