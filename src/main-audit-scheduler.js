/** One repository-owned wake timer; native audit admission remains entirely in the worker [C7]. */
import {
  spawn,
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
} from './git.js';
import {
  withFileLock,
} from './relay-outbox-guard.js';
import {
  readMainAudit,
  saveMainAudit,
} from './main-audit-state.js';

/** Actual OS process start identity prevents mistaking a recycled PID for the timer we own. */
function started(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim(); }
  catch { return null; }
}

/** Schedule one durable wake without borrowing foreground admission or stopping somebody else's process. */
export async function scheduleMainAudit(root, directory, dueAt) {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due) || due <= Date.now()) return;
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
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/main-audit.js', import.meta.url)), root, token, '--scheduled', '--wake-at', dueAt],
      { cwd: root, env, detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    saveMainAudit(file, { version: 1, pid: child.pid, started: started(child.pid), token, dueAt });
    child.unref();
  });
}

/** Wait only as the exact registered timer; the real worker rechecks source, cadence and admission after waking. */
export async function waitMainAudit(directory, token, dueAt) {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) throw new Error('invalid audit wake time');
  for (;;) {
    const remaining = due - Date.now();
    if (remaining <= 0) break;
    await pause(Math.min(remaining, 2147483647));
  }
  return withFileLock(join(directory, 'timer.guard.sqlite'), () => {
    const file = join(directory, 'timer.json'), owner = readMainAudit(file);
    if (owner?.token !== token || owner.pid !== process.pid || owner.dueAt !== dueAt) return false;
    rmSync(file);
    return true;
  });
}
