/** @pullboard-module-loads packages/resources/src/io/stale-test-sweep.js */
/** A gate holder whose process is gone or replaced is freed and its captured request re-run once; the OS decides [C7]. */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { Refused } from '../../../kernel/light.js';

/** Set in the environment of a re-dispatched request so its own holder is never requeued a second time. */
export const LIVENESS_RELAUNCH_ENV = 'PULLBOARD_LIVENESS_RELAUNCH';

/**
 * Record one liveness decision in the durable event table, so a freed or re-dispatched slot can be traced later.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The open slot database inside the caller's write transaction.
 * @param {string} kind - One of terminate, freed, requeue, requeue-spent, or reopen.
 * @param {{ name: string, item: string, pid: number }} row - The holder the decision concerns.
 * @param {string} [detail] - A short human reason for the event.
 */
export function recordLiveness(db, kind, row, detail = '') {
  db.prepare('INSERT INTO liveness_event(at, kind, name, item, pid, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), kind, row.name, row.item ?? '', row.pid, detail);
}

/** The machine's stale-test sweep, loaded on the first lease pass so the runner worker bundle's closure leaves it out (#4140). */
let sweeper;
function sweepStaleTests(db) {
  if (sweeper) sweeper.pass(db, recordLiveness);
  else import('./stale-' + 'test-sweep.js').then(module => { sweeper = module.staleTestSweeper(); }).catch(() => {});
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
function freeHolder(db, row, relaunches, why = 'process gone, or its PID now names another process') {
  db.prepare('DELETE FROM holder WHERE token = ?').run(row.token);
  // The log names the holder it released, so a freed slot never changes hands silently [C7].
  recordLiveness(db, 'freed', row, `released the ${row.name} slot held by ${row.agent || 'an unnamed holder'} (pid ${row.pid}${row.kind ? `, ${row.kind}` : ''}): ${why}`);
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
 * Free holders whose process is gone. The OS decides: a holder is alive while its PID answers (EPERM counts as alive)
 * and its OS start time matches the lease's, so a reused PID never passes. A gone PID, a zombie or a different start
 * frees the slot at once; a live holder is never reclaimed, however stale its heartbeat (#3088, #3154).
 *
 * @param {import('node:sqlite').DatabaseSync} db - The open slot database inside the caller's write transaction.
 * @param {number} now - Epoch milliseconds, kept for the caller's interface.
 * @param {{ alive: (pid: number) => boolean, processIdentity: (pid: number) => ({ started: string, zombie: boolean } | null), freshIdentity?: (pid: number) => ({ started: string, zombie: boolean } | null) }} probes - The slot module's process checks; freshIdentity reads past any cache.
 * @returns {Array<object>} Captured requests to re-dispatch after the commit.
 */
export function reclaimHolders(db, now, probes) {
  sweepStaleTests(db);
  const relaunches = [];
  // Rows are read whole only when one could be freed: every row once any process looks gone, else just the source-cache
  // pins. Why: each write turn read all 1,000 seat rows whole, most of a slot take's own time at 1,000 seats (#8699).
  const suspect = db.prepare('SELECT DISTINCT pid, started FROM holder').all()
    .some(({ pid, started }) => pid !== process.pid && !probes.alive(pid) || identityGone({ pid, started }, probes.processIdentity(pid)));
  const columns = 'SELECT token, name, pid, started, item, request, relaunched, agent, repo, kind FROM holder';
  for (const row of db.prepare(suspect ? columns : `${columns} WHERE kind = 'source-cache'`).all()) {
    if (row.pid !== process.pid && !probes.alive(row.pid)) { freeHolder(db, row, relaunches); continue; }
    // A source-cache pin never expires, so a live orphan whose job directory is gone is freed here (#5593).
    if (sourceCacheJobGone(row)) { freeHolder(db, row, relaunches, 'source-cache pin whose owning job directory is gone'); continue; }
    // A cached identity may predate the PID's reuse, so a mismatch is read again uncached before any row is freed.
    if (identityGone(row, probes.processIdentity(row.pid))
      && identityGone(row, probes.freshIdentity ? probes.freshIdentity(row.pid) : probes.processIdentity(row.pid))) {
      freeHolder(db, row, relaunches);
    }
  }
  return relaunches;
}

/**
 * Whether an identity proves a holder's process gone. An unreadable identity, or one read from a different source than
 * the recorded start, is unknown, not proof of death: the live PID keeps the slot. Our own PID is checked too, since it
 * may reuse a dead holder's PID.
 */
function identityGone(row, identity) {
  return Boolean(identity && (row.pid !== process.pid && identity.zombie || differentStart(identity, row.started)));
}

/**
 * Whether a source-cache holder belongs to a runner job whose directory under <runner root>/jobs no longer exists.
 * The worker names its pins pullboard-ssh-(pin|cache|return)-<job id>, creating <job id>-* first.
 *
 * @param {{ kind: string, agent: string, repo: string }} row - A holder row.
 * @returns {boolean} True only on definite evidence; any unreadable state keeps the holder.
 */
export function sourceCacheJobGone({ kind, agent, repo }) {
  const id = kind === 'source-cache' ? /^pullboard-ssh-(?:pin|cache|return)-(.+)$/u.exec(agent)?.[1] : null;
  if (!id || !isAbsolute(repo) || !existsSync(join(repo, 'jobs'))) return false;
  try { return !readdirSync(join(repo, 'jobs')).some(name => name.startsWith(`${id}-`)); }
  catch { return false; }
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

/** Which reader produced a start identity: a platform fallback tags its value, and ps lstart has no tag. */
function startSource(started) {
  return /^(linux|win):/u.exec(started)?.[1] ?? 'ps';
}

/**
 * Whether a read identity proves a different process than the recorded start: only a start read by the same source
 * can differ; an unrecorded start, or one read another way after a ps failure, is unknown, which counts as alive.
 */
export function differentStart(identity, started) {
  return Boolean(started && identity?.started && startSource(identity.started) === startSource(started) && identity.started !== started);
}

/**
 * The start identity where ps is unavailable: /proc/<pid>/stat field 22 plus the boot time on Linux, Get-Process
 * StartTime on Windows; null when unreadable, which keeps a live PID authoritative (#3154).
 */
export function platformIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const boot = Number(/^btime (\d+)$/mu.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
      return Number.isFinite(boot) ? { started: `linux:${boot}:${fields[19]}`, zombie: fields[0] === 'Z' } : null;
    }
    if (process.platform === 'win32') {
      const ticks = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().Ticks`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
      return /^\d+$/u.test(ticks) ? { started: `win:${ticks}`, zombie: false } : null;
    }
  } catch { /* Unreadable: the live PID stays authoritative. */ }
  return null;
}

/** The heartbeat every holder row carries for older readers: later than any clock, so no age ever looks stale. */
export const PINNED_HEARTBEAT = 8_640_000_000_000_000;

/**
 * Blind every older pullboard's time-based reclaimer. The real heartbeat moves to `beat`; `heartbeat` stays pinned in
 * the future and `terminating` at 0 by triggers that fire for every client. Why: CLIs from before #3154 still killed
 * live holders past their 120 s window; they now free only holders whose process is gone [C7,#3164].
 *
 * @param {import('node:sqlite').DatabaseSync} db - The slot database inside the opener's write transaction.
 */
export function pinLegacyReclaimInputs(db) {
  if (!db.prepare('PRAGMA table_info(holder)').all().some(({ name }) => name === 'beat')) {
    db.exec('ALTER TABLE holder ADD COLUMN beat INTEGER NOT NULL DEFAULT 0');
  }
  const pin = PINNED_HEARTBEAT;
  // Rows an older client wrote before the triggers existed carry their real beat in heartbeat.
  db.exec(`UPDATE holder SET beat = heartbeat WHERE heartbeat <> ${pin};
    UPDATE holder SET heartbeat = ${pin}, terminating = 0 WHERE heartbeat <> ${pin} OR terminating <> 0;`);
  const body = `BEGIN UPDATE holder SET beat = CASE WHEN NEW.heartbeat <> ${pin} THEN NEW.heartbeat ELSE beat END,
    heartbeat = ${pin}, terminating = 0 WHERE token = NEW.token; END`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS holder_pin_insert AFTER INSERT ON holder
      WHEN NEW.heartbeat <> ${pin} OR NEW.terminating <> 0 ${body};
    CREATE TRIGGER IF NOT EXISTS holder_pin_update AFTER UPDATE OF heartbeat, terminating ON holder
      WHEN NEW.heartbeat <> ${pin} OR NEW.terminating <> 0 ${body};`);
}
