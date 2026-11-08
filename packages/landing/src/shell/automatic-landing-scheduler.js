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
import { nextLandingBackoff } from '../core/automatic-landing-retry.js';

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
 * landing racing it (#2541). Only a backed-off landing passes `backoff`, so its record keeps the wait for the attempt
 * after; an accept, a green gate or a test correction schedules without it and starts the waits again [C7].
 */
export async function scheduleAutomaticLanding(root, dueAt, workerUrl, { schedule = scheduleMainAudit, now = Date.now, expectedId, backoff } = {}) {
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
    const next = { version: 1, id: randomUUID(), root: repoInfo(root).root, dueAt: at, by: process.pid, ...(backoff ? { backoff } : {}),
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
 * `run` gets the back-off the record carries and an `onBackoff` that writes a new one into the record, so a lander that
 * dies while backing off is recovered at its backed-off time, not at once. A run that throws is backed off the same way:
 * 60 s, doubling up to 5 minutes while the same error repeats [C7].
 */
export async function resumeAutomaticLanding(root, token, dueAt, run, { wait = waitMainAudit, schedule = scheduleAutomaticLanding, now = Date.now, marks = () => null } = {}) {
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
    const attempt = job;
    const onBackoff = backoff => withPending(directory, () => {
      const saved = readMainAudit(file);
      // The attempt's own record, or the deferral its landing just wrote, carries the back-off; a newer accept never does.
      if (!saved || saved.id !== attempt.id && saved.by !== process.pid) return;
      saveMainAudit(file, { ...saved, dueAt: backoff.retryAt, backoff });
    });
    try { outcome = await run(job.root, { backoff: job.backoff ?? null, onBackoff }); }
    catch (error) {
      const code = String(error.code ?? error.name);
      const backoffMs = nextLandingBackoff(job.backoff, code);
      let observed = null;
      try { observed = marks(job.root); } catch { /* an unreadable board leaves the back-off to its own time */ }
      const retryAt = new Date(now() + backoffMs).toISOString();
      const failed = { ...job, error: error.message, dueAt: retryAt, backoff: { outcome: code, backoffMs, retryAt, marks: observed } };
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
      if (deferred) {
        // Only this run's own record or its own deferral keeps the back-off; a newer accept starts at once, and a wake
        // that cut a back-off short is not held to the backed-off time its record still names.
        const keeps = outcome.backoff && (deferred.id === job.id || deferred.by === process.pid);
        const due = !outcome.backoff && deferred.backoff ? Date.parse(outcome.reloadAt) : Math.max(Date.parse(outcome.reloadAt), Date.parse(deferred.dueAt));
        await schedule(root, new Date(due).toISOString(), outcome.workerUrl, { expectedId: deferred.id, ...(keeps ? { backoff: outcome.backoff } : {}) });
      }
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

/**
 * Recover a durable obligation after a worker disappears; a live or uncertain timer keeps its custody. A backed-off
 * record is restarted at its backed-off time, never at once, unless `woken` reports that an accept, a green gate or a
 * held-test correction happened since the back-off began: then the record is replaced by an immediate wake.
 * Why: every command restarted a failed lander at once, 124 crashing landings in 10 minutes on 6 Nov [C7].
 *
 * @param {string} root
 * @param {URL} workerUrl
 * @param {{ schedule?: typeof scheduleAutomaticLanding, woken?: (job: object) => (boolean | Promise<boolean>) }} [options]
 * @returns {Promise<boolean>} true when this call scheduled a wake
 */
export async function recoverAutomaticLanding(root, workerUrl, { schedule = scheduleAutomaticLanding, woken = () => false } = {}) {
  const directory = automaticLandingDirectory(root);
  const job = readMainAudit(join(directory, 'pending.json'));
  if (!job) return false;
  if (job.version !== 1 || repoInfo(job.root).commonDir !== repoInfo(root).commonDir) throw new Error('automatic landing repository changed');
  if (job.running && running(job.running)) return false;
  // An earlier wake replaces the backed-off timer: the scheduler starts a new timer whenever the new due time is sooner.
  if (job.backoff && await woken(job)) return Boolean(await schedule(job.root, new Date().toISOString(), workerUrl, { expectedId: job.id }));
  const timer = readMainAudit(join(directory, 'timer.json'));
  if (timer && running(timer)) return false;
  await schedule(job.root, job.dueAt, workerUrl, job.backoff ? { backoff: job.backoff } : {});
  return true;
}
