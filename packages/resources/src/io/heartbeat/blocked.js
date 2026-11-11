/** A holder blocked in synchronous work keeps its slot heartbeat from a helper outside its event loop [C7]. */
import { spawn } from 'node:child_process';

/** How often the helper refreshes the holder row; well inside the 120 s hung-holder window. */
export const BLOCKED_HEARTBEAT_MS = 3_000;
/** Overrides the refresh interval in milliseconds; tests use it with a shortened hung-holder window. */
export const BLOCKED_HEARTBEAT_ENV = 'PULLBOARD_BLOCKED_HEARTBEAT_MS';

/** A timed blocking call gets this long past its own timeout before its holder may go stale again. */
export const BLOCKED_HEARTBEAT_MARGIN_MS = 60_000;
/** An untimed blocking call keeps its holder fresh for at most this long; past it, liveness may reclaim it. */
export const BLOCKED_UNTIMED_LIMIT_MS = 60 * 60_000;
/** Overrides the untimed limit in milliseconds; tests use it to make a hung call outlive its deadline quickly. */
export const BLOCKED_UNTIMED_LIMIT_ENV = 'PULLBOARD_BLOCKED_UNTIMED_LIMIT_MS';

/**
 * How long the helper may refresh: the blocking call's own timeout plus a margin, else the untimed limit.
 * Why: refreshing for as long as the parent lives would hide a stopped parent or a call that never returns.
 */
function refreshWindowMs(timeoutMs) {
  if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) return timeoutMs + BLOCKED_HEARTBEAT_MARGIN_MS;
  const value = Number(process.env[BLOCKED_UNTIMED_LIMIT_ENV]);
  return Number.isSafeInteger(value) && value > 0 ? value : BLOCKED_UNTIMED_LIMIT_MS;
}

/** The configured refresh interval, or the default when unset or invalid. */
function blockedHeartbeatMs() {
  const value = Number(process.env[BLOCKED_HEARTBEAT_ENV]);
  return Number.isSafeInteger(value) && value > 0 ? value : BLOCKED_HEARTBEAT_MS;
}

/**
 * The helper's own source. It refreshes only this exact token held by this exact parent PID, and exits once the parent
 * is gone, the row is gone or being terminated, its hard deadline passes, or its stdin closes.
 * Why: the parent's in-process heartbeat is a timer, and a spawnSync gate blocks the timer for the whole run.
 */
const HELPER = `const { DatabaseSync } = require('node:sqlite');
const [file, token, parentText, everyText, deadlineText] = process.argv.slice(1);
const parent = Number(parentText);
const deadline = Number(deadlineText);
let db;
try { db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 2000'); } catch { process.exit(0); }
const beat = () => {
  if (!(Date.now() < deadline)) process.exit(0);
  try { process.kill(parent, 0); } catch { process.exit(0); }
  try {
    const changed = db.prepare('UPDATE holder SET heartbeat = ? WHERE token = ? AND pid = ? AND terminating = 0').run(Date.now(), token, parent).changes;
    if (!changed) process.exit(0);
  } catch { /* A busy pool skips one beat; the next one retries. */ }
};
beat();
setInterval(beat, Number(everyText));
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
`;

/**
 * Keep a lease's holder heartbeat fresh while the caller blocks its own event loop, and return the stop function.
 * A lease without a token and pool file has no holder row, so nothing starts.
 * Why: a landing worker's synchronous runner gate was SIGTERMed as hung after 120 s with no heartbeat (#3130).
 *
 * @param {{ token?: string, pool?: string } | undefined} lease - The held resource lease.
 * @param {{ everyMs?: number, timeoutMs?: number }} [options] - The refresh interval, and the blocking call's own timeout;
 *   refreshing stops at that timeout plus a margin, or at the untimed limit when the call has none.
 * @returns {() => void} Stops the helper; safe to call twice.
 */
export function keepHeartbeatWhileBlocked(lease, { everyMs = blockedHeartbeatMs(), timeoutMs } = {}) {
  const deadline = Date.now() + refreshWindowMs(timeoutMs);
  if (typeof lease?.token !== 'string' || !lease.token || typeof lease.pool !== 'string' || !lease.pool) return () => {};
  let child;
  try {
    child = spawn(process.execPath, ['--no-warnings', '-e', HELPER, lease.pool, lease.token, String(process.pid), String(everyMs), String(deadline)],
      { stdio: ['pipe', 'ignore', 'ignore'], detached: false });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.unref();
    // The stdin pipe is the helper's only tie to this process; it must never keep an in-process `land` alive [C7].
    child.stdin.unref?.();
  } catch { return () => {}; }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    // Destroy, never end: an ended pipe stays open until the helper reads it, and a destroyed one closes now [C7].
    try { child.stdin.destroy(); } catch { /* Already closed. */ }
    try { child.kill('SIGTERM'); } catch { /* Already gone. */ }
  };
}
