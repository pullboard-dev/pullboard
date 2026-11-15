/** The machine's hand-off ticket queue: places in submit order, read by withdraw, gate and the submit wait [C7]. */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { takeResource } from '../../main.js';
import { machineHome } from '../../home.js';
import { Refused } from '../../../../../kernel/light.js';

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

