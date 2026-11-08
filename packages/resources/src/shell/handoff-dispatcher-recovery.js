/** Recover machine-wide queued launches without treating a board read as submit authority [C7]. */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHandoffDispatcher } from './handoff-worker-cap.js';
import { handoffQueueDirectory } from './handoff-worker-cap.js';
import { HANDOFF_DISPATCHER_RESOURCE } from './handoff-worker-cap.js';
import { listResources } from './resources.js';

/** Find captured launch tooling; an unfinished reservation cannot supply executable source. */
function queuedLaunch() {
  const directory = handoffQueueDirectory();
  let names;
  try { names = readdirSync(directory).filter(name => /^\d+-.+\.json$/u.test(name)).sort(); }
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
