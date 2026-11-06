/** Finished submit-handoff folders are pruned by the dispatcher loop, never by a person or agent command [C7]. */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { machineHome } from './machine-home.js';

/** How long a handoff folder stays after its gate ended: 30 minutes. */
export const HANDOFF_FOLDER_KEEP_MS = 30 * 60_000;

/** The most folders removed in one pass, so a backlog drains without a burst of file churn. */
export const HANDOFF_PRUNE_BATCH = 25;

/** Where the dispatcher remembers every submit-handoffs root it has seen, so a later dispatcher sweeps them too. */
function rootsFile() { return join(machineHome(), 'handoff-queue', 'prune-roots'); }

/**
 * Remember the submit-handoffs root that holds a launch's folder.
 * Why: one machine dispatcher serves many repos and only sees folders through launch tickets.
 *
 * @param {string} directory - A launch's handoff folder.
 */
export function rememberHandoffRoot(directory) {
  const root = dirname(directory);
  if (handoffRoots().includes(root)) return;
  try {
    mkdirSync(dirname(rootsFile()), { recursive: true, mode: 0o700 });
    appendFileSync(rootsFile(), root + '\n', { mode: 0o600 });
  } catch { /* a root that cannot be remembered is swept only while its launches run */ }
}

/** Every remembered submit-handoffs root. */
export function handoffRoots() {
  try { return readFileSync(rootsFile(), 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
}

/** Whether a process id is alive. */
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** When the folder's gate ended (its result or unstarted record was written), or null while it may still be queued or running. */
function endedAt(directory) {
  let ended = null;
  for (const name of ['submission.json', 'refusal.json']) {
    try { ended = Math.max(ended ?? 0, statSync(join(directory, name)).mtimeMs); } catch { /* no such result */ }
  }
  let worker;
  try { worker = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8')); } catch { return ended; }
  if (alive(worker.pid)) return null;
  if (ended === null && worker.unstarted) { try { ended = statSync(join(directory, 'worker.json')).mtimeMs; } catch { return null; } }
  return ended;
}

/**
 * Remove handoff folders whose gate ended more than the keep time ago. A folder with no result, a live worker, or a
 * job in `protect` (queued or running) is never removed. Why: 3,477 folders (2.4 GB) kept fseventsd at 2 cores on 6 Nov.
 *
 * @param {string[]} roots - submit-handoffs roots to sweep.
 * @param {{ now?: number, keepMs?: number, protect?: Set<string>, limit?: number }} [options] - Clock, keep time, jobs to spare, batch size.
 * @returns {string[]} Removed folder paths.
 */
export function pruneFinishedHandoffs(roots, { now = Date.now(), keepMs = HANDOFF_FOLDER_KEEP_MS, protect = new Set(), limit = HANDOFF_PRUNE_BATCH } = {}) {
  const removed = [];
  for (const root of new Set(roots)) {
    let names;
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (removed.length >= limit) return removed;
      if (protect.has(name)) continue;
      const directory = join(root, name);
      const ended = endedAt(directory);
      if (ended === null || now - ended < keepMs) continue;
      try { rmSync(directory, { recursive: true, force: true }); removed.push(directory); } catch { /* retried on the next pass */ }
    }
  }
  return removed;
}
