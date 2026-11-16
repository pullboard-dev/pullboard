/** Find and end processes by the runner folder their command line names, which no environment marker can do for Chrome [C7]. */
import { execFile } from 'node:child_process';
import { sep } from 'node:path';

// Budget: a leftover gets 2 s to end on SIGTERM before SIGKILL, then 1 s more to leave the process table.
const GRACE_MS = 2_000;

/**
 * The pids of live processes whose command line names a path inside `folder` (or any of several folders).
 * Why the command line: macOS withholds the environment of Google Chrome, so the PULLBOARD_RUNNER_JOB marker never shows
 * on it, but its --user-data-dir sits in the job's own temp folder; 46 Chrome processes leaked this way (#7811).
 * `orphans` keeps only processes whose parent is init, so a sibling serve's live job is never touched.
 * `environment` also reads each process's environment words after its command line: a local runner or view a test started
 * names only the land clone, but its TMPDIR sits in the job's env folder, so it is found at the job's end (#7819).
 *
 * @param {string | string[]} folder - Each is matched with a trailing separator, so work-0 never matches work-01.
 * @param {{ orphans?: boolean, environment?: boolean, rows?: (environment: boolean) => Promise<string> }} [options] - rows: the `ps -ax -ww -o pid=,ppid=,command=` text (with environment words when asked); default the real one.
 * @returns {Promise<number[]>}
 */
export async function pathProcesses(folder, { orphans = false, environment = false, rows = psRows } = {}) {
  const inside = [folder].flat().map(one => (one.endsWith(sep) ? one : one + sep));
  return (await rows(environment)).split('\n').flatMap(row => {
    const found = /^\s*(\d+)\s+(\d+)\s(.*)$/u.exec(row);
    if (!found || Number(found[1]) === process.pid || (orphans && Number(found[2]) !== 1)) return [];
    return inside.some(one => found[3].includes(one)) ? [Number(found[1])] : [];
  });
}

/** The process table as `pid ppid command` rows, each followed by its environment words when asked; empty when ps fails. */
async function psRows(environment = false) {
  // macOS ps takes -E and procps takes the BSD word e; whichever the host refuses fails at once and the other is tried.
  for (const flag of environment ? ['-E', 'e'] : [null]) {
    const text = await new Promise(resolve => {
      execFile('ps', ['-ax', '-ww', ...(flag ? [flag] : []), '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout)));
    });
    if (text) return text;
  }
  return '';
}

/**
 * End every orphaned process an earlier job left naming a path under `folder`: SIGTERM, a grace, then SIGKILL.
 * Why at start: a runner killed outright never ran its job cleanup, so its next start clears what it left. Returns the pids found.
 *
 * @param {string | string[]} folder - The runner's env and work folders; a process naming another path is never touched.
 * @param {{ graceMs?: number, list?: (folder: string | string[], options: { orphans: boolean }) => Promise<number[]>, pause?: (ms: number) => Promise<void> }} [options]
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
