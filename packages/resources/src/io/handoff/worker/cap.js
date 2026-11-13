/** At most N submit-handoff workers run on the machine at once; the rest wait unspawned in submit order [C7]. */
import { availableParallelism } from 'node:os';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { takeResource } from '../../main.js';
import { machineHome } from '../../home.js';
import { Refused } from '../../../../../kernel/light.js';

/** The machine resource whose slots count running handoff workers. */
export const HANDOFF_WORKER_RESOURCE = 'submit-handoff-workers';

/** The environment variable that overrides the worker cap. */
export const HANDOFF_WORKER_CAP_ENV = 'PULLBOARD_HANDOFF_WORKERS';
/** The most hand-off workers this machine runs at once, whatever the runner fleet offers. */
export const DISPATCH_WORKER_BOUND = 16;

/**
 * The variable a dispatcher sets on each gate worker it starts: the worker's stdin is a pipe the dispatcher holds, and
 * its end means the dispatcher exited, so the worker stops at once (#3899). A worker started any other way has no
 * lifeline and is unaffected.
 */
export const HANDOFF_WORKER_LIFELINE_ENV = 'PULLBOARD_WORKER_LIFELINE';

/** The line a dispatcher that hands the machine over writes on each running worker's lifeline. */
export const HANDOFF_LIFELINE_RELEASE = 'handed-over';

/**
 * Call `stop` once this worker's dispatcher exits: the pipe it holds on this process's stdin ends. A process started
 * without the lifeline is left alone, so a worker run by hand or by a test never stops on its own stdin. A worker whose
 * dispatcher wrote HANDOFF_LIFELINE_RELEASE on the pipe was handed over: it calls `onRelease` and finishes its gate
 * whenever that dispatcher exits [DJ16].
 *
 * @param {() => unknown} stop
 * @param {{ env?: NodeJS.ProcessEnv, stdin?: NodeJS.ReadableStream, onRelease?: () => unknown }} [options]
 * @returns {boolean} Whether a lifeline is watched.
 */
export function onDispatcherLifelineEnd(stop, { env = process.env, stdin = process.stdin, onRelease = () => {} } = {}) {
  if (env[HANDOFF_WORKER_LIFELINE_ENV] !== '1') return false;
  let heard = '';
  let released = false;
  const ended = () => { if (!released) stop(); };
  stdin.on('data', chunk => {
    if (released) return;
    heard = (heard + String(chunk)).slice(-256);
    if (heard.split('\n').slice(0, -1).includes(HANDOFF_LIFELINE_RELEASE)) { released = true; onRelease(); }
  });
  stdin.once('end', ended);
  stdin.once('error', ended);
  stdin.resume();
  return true;
}

/**
 * Tell every worker this dispatcher started that is still running that the machine is handed over, so each finishes
 * its gate whatever becomes of this process. Resolves to how many were told once each write has settled.
 * Why: on 11 Nov handed-over dispatchers died with nothing in their log while their gates ran; every driver then stopped
 * on its lifeline's end and its gate restarted from scratch on the successor (10-60 s of authorization each) [C7,DJ16].
 *
 * @param {Map<unknown, { exited?: boolean, worker?: { stdin?: NodeJS.WritableStream | null } }>} running
 * @returns {Promise<number>}
 */
export async function releaseLifelines(running) {
  const writes = [];
  for (const entry of running.values()) {
    const stdin = entry.worker?.stdin;
    if (entry.exited || !stdin || stdin.destroyed || !stdin.writable) continue;
    // A worker that exits meanwhile closes its end; that write fails into the callback and never ends this process.
    stdin.on('error', () => {});
    writes.push(new Promise(done => stdin.write(`${HANDOFF_LIFELINE_RELEASE}\n`, error => done(!error))));
  }
  return (await Promise.all(writes)).filter(Boolean).length;
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

/** The job id a ticket name belongs to, without its place number, urgent mark or state. */
function ticketJob(name) { return name.replace(/\.(json|reserved)$/u, '').replace(/\.urgent$/u, '').replace(/^\d+-/u, ''); }

/**
 * Whether a job still holds a place in line, reserved or filled. Why: a queued job with neither a place nor a worker
 * record will never start, so the health sweep may end it instead of leaving its claim held for hours (#3121, #3153).
 *
 * @param {string} job - The job id the place would belong to.
 * @returns {boolean}
 */
export function handoffTicketWaiting(job) {
  return waitingTickets().some(name => ticketJob(name) === job);
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
    if (ticketJob(name) !== job) continue;
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

