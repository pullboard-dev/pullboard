/** One repository-owned wake timer; native audit admission remains entirely in the worker [C7]. */
import {
  execFileSync,
} from 'node:child_process';
import {
  randomUUID,
} from 'node:crypto';
import {
  fileURLToPath,
} from 'node:url';
import {
  join,
} from 'node:path';
import {
  rmSync,
} from 'node:fs';
import {
  setTimeout as pause,
} from 'node:timers/promises';
import {
  gitChildEnv,
} from '../../../../../git/index.js';
import {
  withFileLock,
} from '../../../../../outbox/index.js';
import {
  spawnReachable,
} from '../../../../../jobs/index.js';
import {
  readMainAudit,
  saveMainAudit,
} from './state.js';

/** Actual OS process start identity prevents mistaking a recycled PID for the timer we own. */
function started(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim(); }
  catch { return null; }
}

/** The append-only log a scheduled wake writes its stdout and stderr to, inside its own private directory [C7,#2913]. */
export function wakeLogFile(directory) { return join(directory, 'worker.log'); }

/** Schedule one durable wake without borrowing foreground admission or stopping somebody else's process. */
export async function scheduleMainAudit(root, directory, dueAt, workerUrl) {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due) || due <= Date.now()) return;
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:') throw new TypeError('main audit scheduler requires its actual process entry URL');
  await withFileLock(join(directory, 'timer.guard.sqlite'), async () => {
    const file = join(directory, 'timer.json'), old = readMainAudit(file);
    if (old) {
      try {
        process.kill(old.pid, 0);
        const current = started(old.pid);
        if (!current || !old.started) return;
        if (current === old.started && Date.parse(old.dueAt) <= due) return;
      } catch (error) { if (error.code !== 'ESRCH') return; }
    }
    const token = randomUUID(), env = gitChildEnv(root);
    for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[key];
    // The wake keeps its output, so a worker that dies mid-landing leaves its reason in worker.log [C7,#2913]. It starts
    // where it can reach the runners, whichever app ran this command (#5699).
    const { pid } = await spawnReachable(process.execPath, [fileURLToPath(workerUrl), root, token, '--scheduled', '--wake-at', dueAt],
      { cwd: root, env, log: wakeLogFile(directory) });
    if (!pid) throw new Error('the scheduled wake did not start');
    saveMainAudit(file, { version: 1, pid, started: started(pid), token, dueAt });
  });
}

/** Wait only as the exact registered timer; the real worker rechecks source, cadence and admission after waking. */
export async function waitMainAudit(directory, token, dueAt) {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) throw new Error('invalid audit wake time');
  // Sleep the span read once, not until a re-read clock says so: a process that inherits a frozen or stepped Date
  // (a preload that pins it) would otherwise wait forever, a detached timer nobody can end [C7].
  let remaining = due - Date.now();
  while (remaining > 0) {
    const step = Math.min(remaining, 2147483647);
    await pause(step);
    remaining -= step;
  }
  return withFileLock(join(directory, 'timer.guard.sqlite'), () => {
    const file = join(directory, 'timer.json'), owner = readMainAudit(file);
    if (owner?.token !== token || owner.pid !== process.pid || owner.dueAt !== dueAt) return false;
    rmSync(file);
    return true;
  });
}
