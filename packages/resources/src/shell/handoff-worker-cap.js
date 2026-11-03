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

/** The environment variable that overrides the worker cap. */
export const HANDOFF_WORKER_CAP_ENV = 'PULLBOARD_HANDOFF_WORKERS';

/**
 * Count of handoff workers allowed at once: the override when set, else the cores up to a default of 4, raised to
 * one worker per five registered runner slots. Why: a handoff worker mostly waits on a remote runner, so on 3 Nov
 * a cap of 4 left 69 submits queued while 42 of 54 runner slots sat idle.
 *
 * @param {{ env?: object, cores?: number, runnerSlots?: number }} [options] - Environment, core count and total registered runner slots.
 * @returns {number} A positive whole number.
 */
export function handoffWorkerCapacity({ env = process.env, cores = availableParallelism(), runnerSlots = 0 } = {}) {
  const raw = env[HANDOFF_WORKER_CAP_ENV];
  if (raw !== undefined && raw !== '') {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Refused('BAD_HANDOFF_WORKER_CAP', `${HANDOFF_WORKER_CAP_ENV} must be a whole number of 1 or more; unset it for the default`);
    return value;
  }
  const local = Math.max(1, Math.min(4, cores));
  return Number.isSafeInteger(runnerSlots) && runnerSlots > 0 ? Math.max(local, Math.floor(runnerSlots / 5)) : local;
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
 * @param {string} job - The job id the place belongs to.
 * @returns {Promise<string>} The reservation name; pass it to queueHandoffLaunch.
 */
export async function reserveHandoffTicket(job, { startOf = () => '' } = {}) {
  const queue = handoffQueueDirectory();
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const lock = await takeResource({ name: 'submit-handoff-ticket', capacity: 1, scope: 'machine', agent: 'handoff-ticket' });
  try {
    const counter = join(queue, 'next-ticket');
    let next = 1;
    try { next = Number(readFileSync(counter, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Number.isSafeInteger(next) || next < 1 || next === Number.MAX_SAFE_INTEGER) throw new Refused('HANDOFF_TICKET_SOURCE', 'restore the durable next-ticket counter before queueing another worker');
    writeFileSync(counter, String(next + 1), { mode: 0o600 });
    const name = `${String(next).padStart(12, '0')}-${job}.reserved`;
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

/** Places in line, lowest number first; reservations count so a slow submit keeps its turn. */
function waitingTickets() {
  try { return readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
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
 * Start queued workers oldest first, never more than the cap at once, until the queue is empty and all have exited.
 * Each running worker holds one slot of the machine resource pool, so the count is the pool's own.
 * Returns at once when another dispatcher already holds the machine.
 *
 * @param {{ capacity?: number, pollMs?: number }} [options] - The cap and how often new tickets are noticed.
 * @returns {Promise<{ started: string[] }>} Jobs this dispatcher started, in order.
 */
export async function drainHandoffQueue({ capacity = handoffWorkerCapacity(), pollMs = 500, startOf = () => '' } = {}) {
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
    try { await dispatchWhileQueued(capacity, pollMs, started, startOf); }
    finally { lock.release(); }
    // A ticket written while the lock was being released still needs a dispatcher.
    if (!waitingTickets().length) return { started };
  }
}

/** Hold the dispatcher lock, filling free slots from the oldest tickets, until nothing waits or runs. */
async function dispatchWhileQueued(capacity, pollMs, started, startOf) {
  const running = new Set();
  let wake = () => {};
  while (waitingTickets().length || running.size) {
    for (const name of waitingTickets()) {
      // A live reservation holds its place: later submits wait behind it.
      if (name.endsWith('.reserved')) { if (reservationAbandoned(name, startOf)) continue; break; }
      let slot;
      try {
        slot = await takeResource({ name: HANDOFF_WORKER_RESOURCE, capacity, scope: 'machine', agent: 'handoff-worker', kind: 'submit-handoff', allowCapacityGrowth: true,
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
      try { worker = await startWorker(launch, launch.relaunches ?? 0, startOf); }
      catch (error) { slot.release(); throw new Refused('HANDOFF_WORKER_START', `cannot start queued worker ${launch.job}: ${error.message}; restore its captured tools and retry dispatch`); }
      rmSync(file);
      started.push(launch.job);
      running.add(worker);
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
