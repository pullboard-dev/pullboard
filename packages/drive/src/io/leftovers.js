/** Find and end processes by the runner folder their command line names, which no environment marker can do for Chrome [C7]. */
import { execFile } from 'node:child_process';
import { sep } from 'node:path';

// Budget: a leftover gets 2 s to end on SIGTERM before SIGKILL, then 1 s more to leave the process table.
const GRACE_MS = 2_000;

/**
 * The pids of live processes whose command line names a path inside `folder`.
 * Why the command line: macOS withholds the environment of Google Chrome, so the PULLBOARD_RUNNER_JOB marker never shows
 * on it, but its --user-data-dir sits in the job's own temp folder; 46 Chrome processes leaked this way (#7811).
 * `orphans` keeps only processes whose parent is init, so a sibling serve's live job is never touched.
 *
 * @param {string} folder
 * @param {{ orphans?: boolean, rows?: () => Promise<string> }} [options] - rows: the `ps -ax -ww -o pid=,ppid=,command=` text; default the real one.
 * @returns {Promise<number[]>}
 */
export async function pathProcesses(folder, { orphans = false, rows = psRows } = {}) {
  const inside = folder.endsWith(sep) ? folder : folder + sep;
  return (await rows()).split('\n').flatMap(row => {
    const found = /^\s*(\d+)\s+(\d+)\s(.*)$/u.exec(row);
    if (!found || Number(found[1]) === process.pid || (orphans && Number(found[2]) !== 1)) return [];
    return found[3].includes(inside) ? [Number(found[1])] : [];
  });
}

/** The process table as `pid ppid command` rows; empty when ps fails. */
function psRows() {
  return new Promise(resolve => {
    execFile('ps', ['-ax', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout)));
  });
}

/**
 * End every orphaned process an earlier job left naming a path under `folder`: SIGTERM, a grace, then SIGKILL.
 * Why at start: a runner killed outright never ran its job cleanup, so its next start clears what it left. Returns the pids found.
 *
 * @param {string} folder - The runner's jobs folder; a process naming another path is never touched.
 * @param {{ graceMs?: number, list?: (folder: string, options: { orphans: boolean }) => Promise<number[]>, pause?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<number[]>}
 */
export async function reapLeftovers(folder, { graceMs = GRACE_MS, list = pathProcesses, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const kill = (pid, name) => { try { process.kill(pid, name); } catch { /* already gone */ } };
  const found = await list(folder, { orphans: true });
  let left = found;
  for (const pid of left) kill(pid, 'SIGTERM');
  for (const until = Date.now() + graceMs; left.length && Date.now() < until;) { await pause(100); left = await list(folder, { orphans: true }); }
  for (const pid of left) kill(pid, 'SIGKILL');
  return found;
}
