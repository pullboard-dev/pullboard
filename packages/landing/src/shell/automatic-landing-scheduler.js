import { execFileSync } from 'node:child_process';
/** Durable automatic landing wakes reuse native timer custody, never a foreground board connection [B35,B3,R3]. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { repoInfo } from '../../../git/index.js';
import { readMainAudit } from '../../../gate/index.js';
import { saveMainAudit } from '../../../gate/index.js';
import { scheduleMainAudit } from '../../../gate/index.js';
import { waitMainAudit } from '../../../gate/index.js';
import { withFileLock } from '../../../outbox/index.js';

/** Wait for a record's own due time, so a deferral this landing wrote keeps its cadence. */
async function dueBy(dueAt) {
  for (let remaining = Date.parse(dueAt) - Date.now(); remaining > 0; remaining = Date.parse(dueAt) - Date.now()) {
    await pause(Math.min(remaining, 2147483647));
  }
}

/** Bind live custody to the actual OS process start, never a recycled PID. */
function processStart(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 }).trim(); }
  catch { return null; }
}

/** Unknown observations protect custody; only absence or a different start releases it. */
function running(owner) {
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code !== 'ESRCH'; }
  const start = processStart(owner.pid);
  return !start || !owner.started || start === owner.started;
}

/** A repository-private pending record remains readable after the accepting CLI has exited. */
export function automaticLandingDirectory(root) { return join(repoInfo(root).commonDir, 'pullboard', 'automatic-landing'); }

/** One lock orders every pending-record change, so a landing that is finishing never drops a newer accept. */
function withPending(directory, work) { return withFileLock(join(directory, 'pending.guard.sqlite'), work); }

/**
 * The lander entry in the main checkout when the repository carries its own, else the caller's.
 * Why: a seat's worktree or an item folder holds unlanded code, and the command that woke landing ran the lander from
 * its own copy, so unreviewed landing code decided what reached main. A project using an installed CLI has one copy.
 *
 * @param {string} root - Any checkout of the repository.
 * @param {URL} workerUrl - The calling CLI's own lander entry.
 * @returns {URL}
 */
export function mainLandingWorker(root, workerUrl) {
  const commonDir = repoInfo(root).commonDir;
  if (basename(commonDir) !== '.git') return workerUrl;
  const main = join(dirname(commonDir), 'bin', 'automatic-landing.js');
  return existsSync(main) ? pathToFileURL(main) : workerUrl;
}

/**
 * Persist the obligation before starting its authenticated detached timer. A landing already running keeps its
 * custody: the newer record carries it, and that run lands the new work when it finishes instead of a second
 * landing racing it (#2541).
 */
export async function scheduleAutomaticLanding(root, dueAt, workerUrl, { schedule = scheduleMainAudit, now = Date.now, expectedId } = {}) {
  if (!Number.isFinite(Date.parse(dueAt))) throw new TypeError('automatic landing needs its native deferred time');
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:') throw new TypeError('automatic landing needs its actual worker entry');
  workerUrl = mainLandingWorker(root, workerUrl);
  const directory = automaticLandingDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const at = new Date(Math.max(Date.parse(dueAt), now() + 1000)).toISOString();
  const file = join(directory, 'pending.json');
  const job = await withPending(directory, () => {
    const current = readMainAudit(file);
    // A main observer may not replace an accept that arrived while it was reading Git.
    if (expectedId !== undefined && (current?.id ?? null) !== expectedId) return null;
    const next = { version: 1, id: randomUUID(), root: repoInfo(root).root, dueAt: at, by: process.pid,
      ...(current?.running && running(current.running) ? { running: current.running } : {}) };
    saveMainAudit(file, next);
    return next;
  });
  if (!job) return null;
  await schedule(root, directory, at, workerUrl);
  return job;
}

/**
 * Resume only an authenticated wake, retaining failed work and any newer deferral written by landing. A wake that
 * finds another live landing leaves the record to it; the running landing repeats once per newer record, so
 * accepts that arrive together or mid-landing coalesce into the one landing worker (#2541).
 */
export async function resumeAutomaticLanding(root, token, dueAt, run, { wait = waitMainAudit, schedule = scheduleAutomaticLanding } = {}) {
  const directory = automaticLandingDirectory(root);
  if (!await wait(directory, token, dueAt)) return false;
  const file = join(directory, 'pending.json');
  const self = { pid: process.pid, started: processStart(process.pid) };
  let job = await withPending(directory, () => {
    const current = readMainAudit(file);
    if (!current || current.version !== 1 || repoInfo(current.root).commonDir !== repoInfo(root).commonDir) return null;
    if (current.running && running(current.running)) return null;
    saveMainAudit(file, { ...current, running: self });
    return current;
  });
  if (!job) return false;
  while (job) {
    let outcome;
    try { outcome = await run(job.root); }
    catch (error) {
      const failed = { ...job, error: error.message };
      delete failed.running;
      await withPending(directory, () => { if (readMainAudit(file)?.id === failed.id) saveMainAudit(file, failed); });
      throw error;
    }
    if (outcome?.reloadAt) {
      // Release old-tooling custody before starting its replacement timer; even an immediate wake can now acquire it.
      const deferred = await withPending(directory, () => {
        const current = readMainAudit(file);
        if (!current || current.running?.pid !== self.pid || current.running?.started !== self.started) return null;
        const next = { ...current };
        delete next.running;
        saveMainAudit(file, next);
        return next;
      });
      if (deferred) await schedule(root,
        new Date(Math.max(Date.parse(outcome.reloadAt), Date.parse(deferred.dueAt))).toISOString(), outcome.workerUrl,
        { expectedId: deferred.id });
      return true;
    }
    const finished = job;
    job = await withPending(directory, () => {
      const current = readMainAudit(file);
      if (!current) return null;
      if (current.id === finished.id) { rmSync(file); return null; }
      if (current.running?.pid !== process.pid || current.error) return null;
      // An accept made elsewhere while this landing ran is landed by this worker; landing's own deferral goes back to its timer.
      if (current.by !== process.pid) return current;
      const deferred = { ...current };
      delete deferred.running;
      saveMainAudit(file, deferred);
      return null;
    });
    if (job) await dueBy(job.dueAt);
  }
  return true;
}

/** Recover a durable obligation after a worker disappears; a live or uncertain timer keeps its custody. */
export async function recoverAutomaticLanding(root, workerUrl) {
  const directory = automaticLandingDirectory(root);
  const job = readMainAudit(join(directory, 'pending.json'));
  if (!job) return false;
  if (job.version !== 1 || repoInfo(job.root).commonDir !== repoInfo(root).commonDir) throw new Error('automatic landing repository changed');
  if (job.running && running(job.running)) return false;
  const timer = readMainAudit(join(directory, 'timer.json'));
  if (timer && running(timer)) return false;
  await scheduleAutomaticLanding(job.root, job.dueAt, workerUrl);
  return true;
}
