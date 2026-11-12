/** Start a short check in its own process group so the command that asked for it never waits on it [C7]. */
import { spawn } from 'node:child_process';

/**
 * Start `node <entry> ...args` detached with no stdio and let the caller exit at once; returns the child's pid, or
 * null when the spawn failed. Why: a board command that awaited dispatcher recovery spent 4-13 s on it at load 32-50;
 * the check guards itself (the dispatcher launch lock), so nobody needs its answer, only that it runs [C7].
 *
 * @param {string} entry - The script to run.
 * @param {{ args?: string[], cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number | null}
 */
export function startDetachedCheck(entry, { args = [], cwd = process.cwd(), env = process.env } = {}) {
  let child;
  try { child = spawn(process.execPath, [entry, ...args], { cwd, env, detached: true, stdio: 'ignore' }); }
  catch { return null; /* the next command's cheap check asks again once the wake spacing passes */ }
  child.once('error', () => { /* same: an unstarted check is retried by a later command */ });
  child.unref();
  return child.pid ?? null;
}
