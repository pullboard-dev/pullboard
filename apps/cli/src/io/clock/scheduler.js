/** The clock pass runs every minute on its own registered timer, single flight, with no person or agent present [B4,C7]. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AGENT_SESSION_IDS } from '../../../../../packages/kernel/light.js';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/light.js';
import { gitChildEnv } from '../../../../../packages/git/light.js';
import { readTimer } from '../tool/build.js';
import { timerFiles } from '../tool/build.js';
import { writeTimer } from '../tool/build.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** One clock pass per minute. */
export const CLOCK_INTERVAL_MS = 60_000;
const TIMER = { label: 'clock timer', folder: 'clock' };

/**
 * A timer that starts one pass per interval and never two at once. Every due moment registers the next run; a moment
 * that falls while a pass is still running is skipped and counted. All time comes in through `now`, `setTimer` and
 * `clearTimer`, so a fake clock drives it without sleeping.
 */
export function createClockTimer({ intervalMs = CLOCK_INTERVAL_MS, now, setTimer, clearTimer, runPass, register }) {
  const stats = { started: 0, completed: 0, failed: 0, skipped: 0, registered: [] };
  let running = false, stopped = false, handle = null, dueAt = 0;

  /** Record the next due time and arm the timer for it. */
  function arm() {
    dueAt += intervalMs;
    stats.registered.push(dueAt);
    register(dueAt);
    handle = setTimer(onDue, Math.max(0, dueAt - now()));
  }

  /** A due moment: run the pass unless one is still in flight, then register the next moment. */
  function onDue() {
    if (stopped) return;
    if (running) stats.skipped += 1;
    else {
      running = true;
      stats.started += 1;
      Promise.resolve().then(runPass).then(() => { stats.completed += 1; }, () => { stats.failed += 1; })
        .finally(() => { running = false; });
    }
    arm();
  }

  return {
    stats,
    get running() { return running; },
    start() { dueAt = now(); arm(); },
    stop() { stopped = true; if (handle !== null) clearTimer(handle); },
  };
}

/** A timer is neither the caller's agent seat nor a holder of foreground resource admission. */
function workerEnvironment(root) {
  const env = gitChildEnv(root);
  for (const key of [...AGENT_SESSION_IDS, ...AGENT_SHELL_MARKERS, 'PULLBOARD_AGENT', 'PULLBOARD_AGENT_ID',
    'PULLBOARD_PARENT_SESSION', 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[key];
  return env;
}

/** Whether a registered owner process is still alive; unreadable state counts as alive. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** A fresh canonical CLI performs each pass, so no long-lived process holds board code or a connection. */
function freshPass(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'apps/cli/pullboard.js'), 'clock'],
      { cwd: root, env: workerEnvironment(root), stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('close', (status, signal) => (signal || status ? reject(new Error(`clock pass exited ${signal ?? status}`)) : resolve()));
  });
}

/** `pullboard clock --watch`: register one owned timer file, then run a pass every minute until stopped. */
export async function runClockWatch(ctx, { intervalMs = CLOCK_INTERVAL_MS } = {}) {
  const common = fs.realpath(ctx.info.commonDir), root = fs.realpath(ctx.info.root);
  const files = timerFiles(common, true, TIMER);
  const old = readTimer(files.file, TIMER);
  if (old && old.pid !== process.pid && alive(old.pid)) return { ran: false, reason: 'existing-timer', dueAt: old.dueAt };
  const token = randomUUID(), started = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const register = due => writeTimer(files.file, TIMER, { version: 1, token, pid: process.pid, started, dueAt: new Date(due).toISOString(), root, common });
  const timer = createClockTimer({ intervalMs, now: () => Date.now(), setTimer: setTimeout, clearTimer: clearTimeout,
    runPass: () => freshPass(root), register });
  timer.start();
  await new Promise(resolve => { for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, resolve); });
  timer.stop();
  try { fs.unlink(files.file); } catch { /* an already removed registration is the goal */ }
  return { ran: true, stats: timer.stats };
}
