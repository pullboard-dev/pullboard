/** The machine's hand-off ticket queue: places in submit order, read by withdraw, gate and the submit wait [C7]. */
import { join } from 'node:path';
import { machineHome } from '../../home.js';
import { fileSystemAdapter } from '../../../../../fs/index.js';

const fs = fileSystemAdapter();

/** The machine-wide directory of launches waiting for a worker slot. */
export function handoffQueueDirectory() { return join(machineHome(), 'handoff-queue'); }

/** The name mark of a ticket whose item is urgent. */
const URGENT_MARK = '.urgent';

/**
 * Places in line: urgent tickets first, then routine ones, each lowest number first; reservations count so a slow
 * submit keeps its turn. Why urgent first: an unblocking fix must not wait behind routine resubmits (#3062).
 */
function waitingTickets() {
  const urgent = name => name.replace(/\.(json|reserved)$/u, '').endsWith(URGENT_MARK);
  try { return fs.list(handoffQueueDirectory()).filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)).sort().sort((a, b) => Number(urgent(b)) - Number(urgent(a))); }
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
    fs.rm(join(handoffQueueDirectory(), name), { force: true });
    removed += 1;
  }
  return removed;
}
