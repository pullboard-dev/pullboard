/** Start a short check in its own process group so the command that asked for it never waits on it [C7]. */
import { spawn } from 'node:child_process';
import { environmentAdapter } from '../../../env/index.js';

/**
 * Start `node <entry> ...args` detached with no stdio and let the caller exit at once; returns the child's pid, or
 * null when the spawn failed. Why: a board command that awaited dispatcher recovery spent 4-13 s on it at load 32-50;
 * the check guards itself (the dispatcher launch lock), so nobody needs its answer, only that it runs [C7].
 *
 * @param {string} entry - The script to run.
 * @param {{ args?: string[], cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number | null}
 */
export function startDetachedCheck(entry, { args = [], cwd = process.cwd(), env = environmentAdapter().all() } = {}) {
  let child;
  try { child = spawn(process.execPath, [entry, ...args], { cwd, env, detached: true, stdio: 'ignore' }); }
  catch { return null; /* the next command's cheap check asks again once the wake spacing passes */ }
  child.once('error', () => { /* same: an unstarted check is retried by a later command */ });
  child.unref();
  return child.pid ?? null;
}

/**
 * Start `node <entry> ...args` through spawnReachable, so a dispatcher launched from an app that holds a denied Local
 * Network permission still reaches the runners; returns the started process's pid, or null when nothing started.
 * Why: the dispatcher launch is the last long-lived start that stayed a plain detached spawn; the caller picks this over
 * startDetachedCheck only when launch.reachableDispatcher is on, and this cell sits below config so it cannot read it [C7].
 * Same contract as startDetachedCheck: never awaited on the caller's command path, never rejects.
 *
 * @param {string} entry - The script to run.
 * @param {{ args?: string[], cwd?: string, env?: NodeJS.ProcessEnv, home?: string, launchd?: boolean, launcher?: (args: string[]) => Promise<{ status: number, stdout: string }> }} [options] - home, launchd and launcher pass straight to spawnReachable.
 * @returns {Promise<number | null>}
 */
export async function startReachableCheck(entry, { args = [], cwd = process.cwd(), env = environmentAdapter().all(), home, launchd, launcher } = {}) {
  try {
    const { spawnReachable } = await import('../../../jobs/index.js');
    const started = await spawnReachable(process.execPath, [entry, ...args], { cwd, env, ...(home === undefined ? {} : { home }), ...(launchd === undefined ? {} : { launchd }), ...(launcher === undefined ? {} : { launcher }) });
    return started.pid ?? null;
  } catch { return null; /* the next command's cheap check asks again once the wake spacing passes */ }
}
