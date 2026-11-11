/**
 * One background main-red refresh per machine, started at most once per spacing window [C7].
 *
 * Why: every landing started two detached refreshes (base and published), each ran for minutes, and on 9 Nov they piled
 * up orphaned under launchd while ~40 processes queued on the repo's resource database behind them. A refresh is a read
 * plus a cache write: a second one while the first runs only repeats its work, and the next landing starts a fresh one.
 */
import { closeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { machineHome } from '../../../../../../resources/index.js';

/** The least time between two refresh starts on one machine; PULLBOARD_MAIN_RED_REFRESH_SPACING_MS overrides it. */
export const REFRESH_SPACING_MS = 5 * 60_000;

/** The lock a running refresh holds, and the stamp of the last start, in private machine storage. */
export function refreshFlightFiles(home = machineHome()) {
  return { lock: join(home, 'main-red-refresh.lock'), stamp: join(home, 'main-red-refresh.started') };
}

/** The spacing in force: the override when it is a whole number of milliseconds, else the default. */
function spacingMs() {
  const raw = Number(process.env.PULLBOARD_MAIN_RED_REFRESH_SPACING_MS);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : REFRESH_SPACING_MS;
}

/** How long a refresh lock counts at most, even with its pid alive: a reused pid never holds it forever. */
const LOCK_LIFETIME_MS = 30 * 60_000;

/**
 * The running refresh named by the lock, or null when there is none, its process has exited, or the lock is older than
 * its lifetime (a heavy refresh took 9 minutes on 6 Nov; a pid reused since then is not that refresh). Why no ps: this
 * runs in the lander, whose lease timer a synchronous child process would stall.
 */
export function runningRefresh(files = refreshFlightFiles(), now = Date.now()) {
  let holder;
  try { holder = JSON.parse(readFileSync(files.lock, 'utf8')); } catch { return null; }
  if (!Number.isSafeInteger(holder?.pid) || holder.pid < 1 || !Number.isFinite(holder.at) || now - holder.at > LOCK_LIFETIME_MS) return null;
  try { process.kill(holder.pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; }
  return holder;
}

/**
 * Whether a caller may start a refresh now: none runs and none started within the spacing. A yes records the start,
 * so callers racing within the same moment start at most one more; the child's own lock settles any that slip by.
 */
export function claimRefreshStart(files = refreshFlightFiles(), now = Date.now()) {
  if (runningRefresh(files)) return false;
  try { if (now - statSync(files.stamp).mtimeMs < spacingMs()) return false; } catch { /* Never started: free to start. */ }
  mkdirSync(join(files.stamp, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(files.stamp, String(now), { mode: 0o600 });
  try { utimesSync(files.stamp, now / 1000, now / 1000); } catch { /* The write already set a current mtime. */ }
  return true;
}

/**
 * Take the machine's one refresh lock for this process, or return null when a live refresh holds it. A lock left by
 * an exited process, or past its lifetime, is taken over. The returned function lets it go.
 */
export function holdRefreshFlight(files = refreshFlightFiles()) {
  mkdirSync(join(files.lock, '..'), { recursive: true, mode: 0o700 });
  const record = JSON.stringify({ pid: process.pid, at: Date.now() }) + '\n';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(files.lock, 'wx', 0o600);
      try { writeSync(fd, record); } finally { closeSync(fd); }
      return () => {
        try { if (JSON.parse(readFileSync(files.lock, 'utf8')).pid === process.pid) unlinkSync(files.lock); }
        catch { /* Already gone: nothing to let go. */ }
      };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (runningRefresh(files)) return null;
    try { unlinkSync(files.lock); } catch { /* Another starter removed the stale lock first. */ }
  }
  return null;
}
