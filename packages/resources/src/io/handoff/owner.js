/** Which machine queue holds a queued gate's place in line, so only that queue's sweep may call the place lost [C7]. */
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handoffQueueDirectory } from './worker/cap.js';

/** The file beside a hand-off that names the machine queue its place in line was written to. */
const QUEUE_FILE = 'queue.json';

/** The marker a lost place in line leaves once it is re-placed. */
const REPLACED_FILE = 'ticket-replaced';

/**
 * Record which machine queue holds this hand-off's place in line. An unwritable folder records nothing and leaves the
 * old judgement in force.
 *
 * @param {string} directory - The hand-off's folder.
 */
export function recordHandoffQueue(directory) {
  try { writeFileSync(join(directory, QUEUE_FILE), JSON.stringify({ queue: handoffQueueDirectory() }) + '\n', { mode: 0o600 }); }
  catch { /* the sweep then judges this job by its own queue, as before */ }
}

/**
 * Whether this hand-off's place in line was written to another machine queue than the one this process reads.
 * Why: on 8 Nov a dispatcher a test left running with a temporary machine home swept the real board, saw none of its
 * tickets, and ended 38 queued gates in 3 hours as "no place in line" minutes before the real dispatcher started them;
 * it also queued their retries into its deleted home (ENOENT resources.sqlite.write) [C7].
 *
 * @param {string} directory - The hand-off's folder.
 * @returns {boolean}
 */
export function queuedElsewhere(directory) {
  let recorded;
  try { recorded = JSON.parse(readFileSync(join(directory, QUEUE_FILE), 'utf8')).queue; } catch { return false; }
  return typeof recorded === 'string' && recorded !== handoffQueueDirectory();
}

/**
 * Mark a lost place in line as re-placed, once: true the first time, false when it was already re-placed.
 * Why: a queued job keeps its gate when its ticket goes missing; only a second loss is an infrastructure stop.
 *
 * @param {string} directory - The hand-off's folder.
 * @returns {boolean}
 */
export function replaceLostTicketOnce(directory) {
  try { writeFileSync(join(directory, REPLACED_FILE), `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 }); return true; }
  catch { return false; }
}
