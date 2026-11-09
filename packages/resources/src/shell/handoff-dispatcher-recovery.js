/** Recover machine-wide queued launches without treating a board read as submit authority [C7]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHandoffDispatcher } from './handoff-worker-cap.js';
import { handoffDispatcherHeartbeat } from './handoff-worker-cap.js';
import { handoffQueueDirectory } from './handoff-worker-cap.js';
import { HANDOFF_DISPATCHER_RESOURCE } from './handoff-worker-cap.js';
import { listResources } from './resources.js';

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
 * Decide, in about a millisecond, whether this command should start a detached recovery check, and claim the turn when
 * it should: true only when launches are queued, no dispatcher heartbeat is fresh, and no other command started a check
 * within HANDOFF_WAKE_SPACING_MS. Why: the full check (recoverHandoffDispatcher) reads the machine's slot database and
 * probes holder processes, which cost every board command 4-13 s at load 32-50; it now runs detached, and only here
 * when the cheap evidence says the dispatcher may be dead. A false alarm costs one detached check that starts nothing [C7].
 *
 * @param {{ now?: number }} [options]
 * @returns {boolean}
 */
export function claimHandoffDispatcherWake({ now = Date.now() } = {}) {
  const directory = handoffQueueDirectory();
  let names;
  try { names = readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!names.some(name => TICKET.test(name))) return false;
  if (now - modifiedAt(handoffDispatcherHeartbeat()) < HANDOFF_HEARTBEAT_FRESH_MS) return false;
  const turn = join(directory, 'recovery-woken');
  if (now - modifiedAt(turn) < HANDOFF_WAKE_SPACING_MS) return false;
  writeFileSync(turn, `${process.pid}\n`, { mode: 0o600 });
  return true;
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
