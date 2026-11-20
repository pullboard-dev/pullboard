/**
 * The one-service-per-runner-root lock: a `serve.lock` file in the cache folder, taken with the exclusive flag [P7].
 * Why: two runner services on one root (an old system daemon and a user agent) each claimed their own slots, doubling concurrency and load.
 * The file holds the holder's pid, its process start time and how it was started; a pid that is not running, or whose start time differs, is a dead holder and is taken over.
 * This file imports only Node built-ins, so the installed runner bundle carries it with the service entry.
 */
import { closeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** A process's start time as `ps -o lstart=` prints it, or an empty string when no such process is running. */
export function processStart(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** How this process was started: the launchd label when the service manager set one, else its parent pid. */
function startedBy(env, ppid) {
  const label = env.XPC_SERVICE_NAME;
  return label && label !== '0' ? `launchd ${label}` : `parent pid ${ppid}`;
}

/**
 * Take the runner lock in a cache folder, or refuse RUNNER_ALREADY_RUNNING naming the live holder's pid and how it was started.
 *
 * @param {string} cache - The runner's cache folder; it is made when absent.
 * @param {{ pid?: number, ppid?: number, env?: Record<string, string | undefined>, startOf?: (pid: number) => string }} [ports] - This process's ids and the start-time reader, replaced by a test.
 * @returns {{ file: string, holder: { pid: number, started: string, via: string }, release: () => void }} The lock; release removes the file only while it still names this pid.
 */
export function takeRunnerLock(cache, { pid = process.pid, ppid = process.ppid, env = process.env, startOf = processStart } = {}) {
  mkdirSync(cache, { recursive: true });
  const file = join(cache, 'serve.lock');
  const holder = { pid, started: startOf(pid), via: startedBy(env, ppid) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, JSON.stringify(holder)); } finally { closeSync(fd); }
      return { file, holder, release() {
        try { if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) unlinkSync(file); } catch { /* already gone: nothing to release */ }
      } };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let held = null;
    try { held = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; }
    if (held && Number.isInteger(held.pid) && held.started && startOf(held.pid) === held.started) {
      throw Object.assign(new Error(`another runner service holds ${file}: pid ${held.pid}, started by ${held.via ?? 'unknown'}; one service serves a runner root`), { code: 'RUNNER_ALREADY_RUNNING' });
    }
    try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Object.assign(new Error(`the runner lock ${file} kept changing hands; try again`), { code: 'RUNNER_ALREADY_RUNNING' });
}
