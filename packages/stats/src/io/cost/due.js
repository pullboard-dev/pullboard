/** Usage checkpoints a board command only records as due; one detached worker runs them in order [N2,B3]. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { AGENT_SHELL_MARKERS } from '../../../../kernel/index.js';
import { AGENT_TRANSCRIPT_ENV } from './session.js';
import { storeName } from '../store-names.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/** `inline` runs the checkpoint inside the command, as before #2504; any other value defers it to the worker. */
export const USAGE_CHECKPOINT_ENV = 'PULLBOARD_USAGE_CHECKPOINT';
/** Only what locates and attributes the caller's native session travels with a due checkpoint. */
const SESSION_ENV = [...AGENT_SHELL_MARKERS, ...AGENT_TRANSCRIPT_ENV, 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME'];
const REQUEST = /^\d{15}-\d{12}-[0-9a-z-]+\.json$/u;
const LOG_LIMIT = 256 * 1024;
/** How long a due checkpoint waits for another writer of the private ledger before it counts as failed. */
const LEDGER_WAIT_MS = 120_000;

/** True when this process must checkpoint in its own foreground, the pre-#2504 behaviour. */
export function usageCheckpointInline(environment = process.env) {
  return environment[USAGE_CHECKPOINT_ENV] === 'inline';
}

/** The private per-repository folder of due checkpoints. */
export function usageDueDirectory(commonDir) {
  return join(commonDir, 'pullboard', 'usage-due');
}

/** Due request files, oldest first: names sort by move time, then by the last board event they may read. */
function pending(directory) {
  try { return fs.list(directory).filter((name) => REQUEST.test(name)).sort(); } catch { return []; }
}

/** A recorded pid that still runs, so a second worker never starts beside it. */
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Take the single-worker lock, clearing one left by a worker that died. */
function takeLock(directory) {
  const lock = join(directory, 'worker.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.open(lock, 'wx', 0o600);
      try { fs.write(fd, String(process.pid)); } finally { fs.close(fd); }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
      let owner;
      try { owner = Number(fs.readFile(lock, 'utf8')); } catch { continue; }
      // A lock still being written has no pid yet; its writer is starting and will drain.
      if (!owner || alive(owner)) return false;
      fs.rm(lock, { force: true });
    }
  }
  return false;
}

/** Whether a live worker holds the queue now. */
function workerRunning(directory) {
  try { return alive(Number(fs.readFile(join(directory, 'worker.lock'), 'utf8'))); } catch { return false; }
}

/** Keep a short private failure log: stage names only, never paths or session identities. */
function logFailure(directory, line) {
  const file = join(directory, 'worker.log');
  try {
    if (fs.stat(file).size > LOG_LIMIT) fs.rm(file, { force: true });
  } catch { /* no log yet */ }
  try { fs.appendFile(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* the log is best effort */ }
}

/**
 * Record that a lifecycle move owes a usage checkpoint and wake the worker; no session log is read here.
 * Why: on the live board this checkpoint was 58 s of a 94 s claim, re-reading every agent log in the command.
 */
export function queueUsageCheckpoint(info, board, { agent, item, operation }, { worker, now, environment = process.env }) {
  const directory = usageDueDirectory(info.commonDir);
  fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lastEventId = board.db.prepare('SELECT max(event_id) AS id FROM event').get()?.id ?? 0;
  const session = Object.fromEntries(SESSION_ENV.filter((name) => typeof environment[name] === 'string').map((name) => [name, environment[name]]));
  const request = { version: 1, root: info.root, agent, item, operation, now, lastEventId, environment: session };
  const name = `${String(now).padStart(15, '0')}-${String(lastEventId).padStart(12, '0')}-${process.pid}-${storeName(randomUUID())}`;
  const temporary = join(directory, `.${name}.tmp`);
  fs.writeFile(temporary, JSON.stringify(request), { mode: 0o600 });
  fs.rename(temporary, join(directory, name));
  if (workerRunning(directory)) return;
  // The worker never holds this agent's checkout or acts as its shell: it orders only numeric usage for the seat at `root`.
  const env = { ...environment };
  for (const marker of [...AGENT_SHELL_MARKERS, 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[marker];
  const child = spawn(process.execPath, [worker, info.commonDir], { cwd: info.commonDir, detached: true, stdio: 'ignore', env });
  child.on('error', () => logFailure(directory, 'stage=spawn'));
  child.unref();
}

/** Run every due checkpoint in order under one lock; a request queued while the lock drops is still drained. */
export async function drainUsageCheckpoints(commonDir, run) {
  const directory = usageDueDirectory(commonDir);
  while (pending(directory).length) {
    if (!takeLock(directory)) return;
    try {
      for (let next = pending(directory)[0]; next; next = pending(directory)[0]) {
        const file = join(directory, next);
        let request = null;
        try { request = JSON.parse(fs.readFile(file, 'utf8')); } catch { logFailure(directory, 'stage=request'); }
        // A failed checkpoint keeps today's semantics: unpublished revisions go out with the next checkpoint.
        for (const started = Date.now(); request;) {
          try { await run(request); break; }
          catch (error) {
            // Another writer holds the private ledger; off the command path, waiting for it costs no one.
            if (error?.code === 'USAGE_LEDGER' && Date.now() - started < LEDGER_WAIT_MS) { await pause(200); continue; }
            logFailure(directory, `stage=checkpoint code=${typeof error?.code === 'string' ? error.code : 'unknown'}`);
            break;
          }
        }
        fs.rm(file, { force: true });
      }
    } finally { fs.rm(join(directory, 'worker.lock'), { force: true }); }
  }
}
