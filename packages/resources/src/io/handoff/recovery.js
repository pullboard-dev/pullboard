/** Recover machine-wide queued launches without treating a board read as submit authority [C7]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHandoffDispatcher } from './worker/cap.js';
import { handoffDispatcherHeartbeat } from './worker/cap.js';
import { handoffQueueDirectory } from './worker/cap.js';
import { HANDOFF_DISPATCHER_RESOURCE } from './worker/cap.js';
import { listResources } from '../main.js';

/** A captured launch ticket's file name in the machine's hand-off queue. */
const TICKET = /^\d+-.+\.json$/u;

/** A heartbeat younger than this proves a dispatcher is passing; a pass beats about every half second. */
export const HANDOFF_HEARTBEAT_FRESH_MS = 30_000;

/** At most one detached recovery check starts per this many milliseconds, however many commands run. */
export const HANDOFF_WAKE_SPACING_MS = 10_000;

/** A file's modification time in milliseconds, or 0 when it does not exist. */
function modifiedAt(file) {
  try { return statSync(file).mtimeMs; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

/**
 * Claim this command's turn to start the background recovery job: true at most once per HANDOFF_WAKE_SPACING_MS
 * machine-wide, whatever the queue holds. The command checks nothing about the dispatcher; one stat and, on its turn,
 * one write are all it pays. Why: recovery on every command's path (listing the machine's lock holders, probing their
 * processes, waiting on the launch lock) cost 4-13 s per command at load 32-50; the background job owns it now [C7].
 *
 * @param {{ now?: number }} [options]
 * @returns {boolean}
 */
export function claimHandoffRecoveryTurn({ now = Date.now() } = {}) {
  const directory = handoffQueueDirectory();
  const turn = join(directory, 'recovery-woken');
  if (now - modifiedAt(turn) < HANDOFF_WAKE_SPACING_MS) return false;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(turn, `${process.pid}\n`, { mode: 0o600 });
  return true;
}

/**
 * Whether the dispatcher may be dead with work waiting: a launch is queued and no heartbeat is fresh. The background
 * recovery job reads this first so a live dispatcher costs it one directory read and one stat, never the slot database.
 *
 * @param {{ now?: number }} [options]
 * @returns {boolean}
 */
export function handoffDispatcherMayBeDead({ now = Date.now() } = {}) {
  let names;
  try { names = readdirSync(handoffQueueDirectory()); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!names.some(name => TICKET.test(name))) return false;
  return now - modifiedAt(handoffDispatcherHeartbeat()) >= HANDOFF_HEARTBEAT_FRESH_MS;
}

/** Find captured launch tooling; an unfinished reservation cannot supply executable source. */
function queuedLaunch() {
  const directory = handoffQueueDirectory();
  let names;
  try { names = readdirSync(directory).filter(name => TICKET.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names) {
    try { return JSON.parse(readFileSync(join(directory, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

/**
 * Wake the existing queue from its captured tools, retaining the ordinary singleton and PID-incarnation guards.
 * Load process observation only when a queued launch has no dispatcher resource holder.
 */
export async function recoverHandoffDispatcher({ loadStartOf }) {
  const launch = queuedLaunch();
  if (!launch) return;
  const dispatcher = listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_DISPATCHER_RESOURCE);
  if (dispatcher?.holders?.length) return;
  await ensureHandoffDispatcher(launch.tools, launch.commonDir, { startOf: await loadStartOf() });
}
