import { execFileSync } from 'node:child_process';
/** Durable automatic landing wakes reuse native timer custody, never a foreground board connection [B35,B3,R3]. */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from '../../../git/index.js';
import { readMainAudit } from '../../../gate/index.js';
import { saveMainAudit } from '../../../gate/index.js';
import { scheduleMainAudit } from '../../../gate/index.js';
import { waitMainAudit } from '../../../gate/index.js';

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

/** Persist the obligation before starting its authenticated detached timer. */
export async function scheduleAutomaticLanding(root, dueAt, workerUrl, { schedule = scheduleMainAudit, now = Date.now } = {}) {
  if (!Number.isFinite(Date.parse(dueAt))) throw new TypeError('automatic landing needs its native deferred time');
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:') throw new TypeError('automatic landing needs its actual worker entry');
  const directory = automaticLandingDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const at = new Date(Math.max(Date.parse(dueAt), now() + 1000)).toISOString();
  const job = { version: 1, id: randomUUID(), root: repoInfo(root).root, dueAt: at };
  saveMainAudit(join(directory, 'pending.json'), job);
  await schedule(root, directory, at, workerUrl);
  return job;
}

/** Resume only an authenticated wake, retaining failed work and any newer deferral written by landing. */
export async function resumeAutomaticLanding(root, token, dueAt, run, { wait = waitMainAudit } = {}) {
  const directory = automaticLandingDirectory(root);
  if (!await wait(directory, token, dueAt)) return false;
  const file = join(directory, 'pending.json'), job = readMainAudit(file);
  if (!job || job.version !== 1 || repoInfo(job.root).commonDir !== repoInfo(root).commonDir) return false;
  saveMainAudit(file, { ...job, running: { pid: process.pid, started: processStart(process.pid) } });
  try { await run(job.root); }
  catch (error) {
    if (readMainAudit(file)?.id === job.id) saveMainAudit(file, { ...job, error: error.message });
    throw error;
  }
  if (readMainAudit(file)?.id === job.id) rmSync(file);
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
