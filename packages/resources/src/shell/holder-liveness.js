/** A gate holder that stops heartbeating is terminated, its slot freed, and its captured request re-run once [C7]. */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { Refused } from '../../../kernel/index.js';

/** A holder with no heartbeat for this long is hung; a live hung holder is terminated and its slot freed. */
export const STALE_HOLDER_MS = 120_000;
/** Overrides the hung-holder window in milliseconds; tests use it to reach the window quickly. */
export const STALE_HOLDER_ENV = 'PULLBOARD_STALE_HOLDER_MS';
/** How long a terminated holder gets after SIGTERM before SIGKILL; its slot stays held until its PID is gone. */
export const HOLDER_KILL_GRACE_MS = 10_000;
/** Overrides the SIGTERM-to-SIGKILL grace in milliseconds. */
export const HOLDER_KILL_GRACE_ENV = 'PULLBOARD_HOLDER_KILL_GRACE_MS';
/** Set in the environment of a re-dispatched request so its own holder is never requeued a second time. */
export const LIVENESS_RELAUNCH_ENV = 'PULLBOARD_LIVENESS_RELAUNCH';

/**
 * The configured hung-holder window, or the default when unset or invalid.
 *
 * @returns {number} Milliseconds without a heartbeat before a live holder counts as hung.
 */
function staleHolderMs() {
  const value = Number(process.env[STALE_HOLDER_ENV]);
  return Number.isSafeInteger(value) && value > 0 ? value : STALE_HOLDER_MS;
}

/**
 * The configured SIGTERM-to-SIGKILL grace, or the default when unset or invalid.
 *
 * @returns {number} Milliseconds a terminated holder has to exit before SIGKILL.
 */
function holderKillGraceMs() {
  const value = Number(process.env[HOLDER_KILL_GRACE_ENV]);
  return Number.isSafeInteger(value) && value > 0 ? value : HOLDER_KILL_GRACE_MS;
}

/**
 * Send a signal to a holder's process group, falling back to the process itself when it leads no group.
 * Why: a detached holder leads its own group, so its children die with it; a holder that does not lead one still gets the signal.
 *
 * @param {number} pid - The holder's process ID, already verified as the recorded incarnation.
 * @param {'SIGTERM'|'SIGKILL'} signal - The signal to send.
 */
function signalHolder(pid, signal) {
  try { process.kill(-pid, signal); return; } catch { /* No group leads with this PID; signal the process itself. */ }
  try { process.kill(pid, signal); } catch { /* Already gone, which is the outcome we want. */ }
}

/**
 * Record one liveness decision in the durable event table, so a freed or re-dispatched slot can be traced later.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The open slot database inside the caller's write transaction.
 * @param {string} kind - One of terminate, freed, requeue, requeue-spent, or reopen.
 * @param {{ name: string, item: string, pid: number }} row - The holder the decision concerns.
 * @param {string} [detail] - A short human reason for the event.
 */
function recordLiveness(db, kind, row, detail = '') {
  db.prepare('INSERT INTO liveness_event(at, kind, name, item, pid, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), kind, row.name, row.item ?? '', row.pid, detail);
}

/**
 * Remove a holder whose process is gone and decide what happens to its captured request.
 * A request is re-dispatched once: a holder that was itself a re-dispatch is recorded as spent, never requeued again.
 * Why: the row goes only once the PID is gone, so the rerun never overlaps the process it replaces.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The open slot database inside the caller's write transaction.
 * @param {{ token: string, name: string, pid: number, item: string, request: string, relaunched: number }} row - The holder row to free.
 * @param {Array<object>} relaunches - Collects the requests to re-dispatch after the transaction commits.
 */
function freeHolder(db, row, relaunches) {
  db.prepare('DELETE FROM holder WHERE token = ?').run(row.token);
  recordLiveness(db, 'freed', row, 'process gone or hung past its window');
  if (!row.request) {
    recordLiveness(db, 'reopen', row, 'no captured request; the item reopens to its holder through next');
    return;
  }
  if (row.relaunched) {
    recordLiveness(db, 'requeue-spent', row, 'the captured request was already re-dispatched once');
    return;
  }
  const { argv, cwd } = JSON.parse(row.request);
  recordLiveness(db, 'requeue', row, 'captured request re-dispatched once');
  relaunches.push({ argv, cwd, item: row.item, name: row.name });
}

/**
 * Free holders whose process is gone, and terminate live holders that stopped heartbeating.
 * A live holder with no heartbeat for the hung window gets SIGTERM, then SIGKILL after the grace period; its row goes
 * only once its PID is gone. Identity is checked before any signal, so a reused PID is never signalled.
 * Why: a hung holder otherwise keeps its slot indefinitely, and nothing else can release it.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The open slot database inside the caller's write transaction.
 * @param {number} now - Epoch milliseconds for the staleness comparisons.
 * @param {{ alive: (pid: number) => boolean, processIdentity: (pid: number) => ({ started: string, zombie: boolean } | null), sameProcess: (pid: number, started: string) => boolean, leaseMs: number }} probes - The slot module's process checks and lease window.
 * @returns {Array<object>} Captured requests to re-dispatch after the commit.
 */
export function reclaimHolders(db, now, probes) {
  const relaunches = [];
  const leaseCutoff = now - probes.leaseMs;
  const hungCutoff = now - staleHolderMs();
  for (const row of db.prepare('SELECT token, name, pid, started, item, heartbeat, terminating, request, relaunched FROM holder').all()) {
    if (row.pid === process.pid) continue;
    if (!probes.alive(row.pid)) { freeHolder(db, row, relaunches); continue; }
    if (row.heartbeat < leaseCutoff && !probes.sameProcess(row.pid, row.started)) { freeHolder(db, row, relaunches); continue; }
    if (!(row.terminating > 0 || row.heartbeat < hungCutoff)) continue;
    // Only a verified incarnation is signalled; an unknown identity is kept, never guessed at.
    const identity = row.started ? probes.processIdentity(row.pid) : null;
    if (!identity || identity.zombie || identity.started !== row.started) continue;
    if (row.terminating === 0) {
      signalHolder(row.pid, 'SIGTERM');
      db.prepare('UPDATE holder SET terminating = ? WHERE token = ?').run(now, row.token);
      recordLiveness(db, 'terminate', row, 'no heartbeat past the hung window; SIGTERM sent');
    } else if (now - row.terminating >= holderKillGraceMs()) {
      signalHolder(row.pid, 'SIGKILL');
    }
  }
  return relaunches;
}

/**
 * Re-dispatch one captured request as a fresh detached process, marked so its own holder is never requeued again.
 * Called only after the commit, so a rolled-back free never starts a second run.
 *
 * @param {{ argv: string[], cwd: string, item: string, name: string }} relaunch - The captured command to run once.
 */
export function dispatchRelaunch(relaunch) {
  const label = relaunch.item || relaunch.name;
  try {
    const child = spawn(relaunch.argv[0], relaunch.argv.slice(1), {
      cwd: relaunch.cwd || undefined,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [LIVENESS_RELAUNCH_ENV]: '1' },
    });
    child.on('error', error => process.stderr.write(`liveness: re-dispatch of ${label} failed: ${error.message}\n`));
    child.unref();
  } catch (error) {
    process.stderr.write(`liveness: re-dispatch of ${label} failed: ${error.message}\n`);
  }
}

/**
 * Validate the command a holder captured so its slot can re-run it once if the holder is freed.
 * Why: a hung or dead holder must not drop its job, and a re-run needs an exact argv, never a shell string.
 *
 * @param {unknown} value - The capturedRequest option, or undefined when none is captured.
 * @returns {string} The JSON to store on the holder row, or '' when nothing was captured.
 */
export function capturedRequestOf(value) {
  if (value === undefined) return '';
  if (!value || typeof value !== 'object' || !Array.isArray(value.argv) || value.argv.length < 1
    || value.argv.some(part => typeof part !== 'string' || !part || part.includes('\0'))
    || value.cwd !== undefined && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd))) {
    throw new Refused('BAD_RESOURCE_METADATA', 'capturedRequest needs argv, a non-empty array of strings, and an optional absolute cwd');
  }
  return JSON.stringify({ argv: [...value.argv], cwd: value.cwd ?? '' });
}
