/** The running resident board processes of this checkout, with what doctor needs to know about how each started [C7,#5760]. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gitLocation } from './client.js';

/** The label prefix of the launchd jobs the daemons start as (packages/jobs/src/io/launch.js). */
const LAUNCH_LABEL = 'dev.pullboard.daemon.';

/** The pids launchd runs under a Pullboard daemon label; empty without launchd. */
function launchdPids(run) {
  const listed = run('/bin/launchctl', ['list']);
  if (listed.status !== 0) return new Set();
  return new Set(String(listed.stdout).split('\n').map(line => line.split('\t')).filter(([pid, , label]) => /^\d+$/u.test(pid) && label?.startsWith(LAUNCH_LABEL)).map(([pid]) => Number(pid)));
}

/** The bundle identifier a process's environment names, or null; `ps -E` prints the environment after the command. */
function appBundleOf(pid, run) {
  const shown = run('/bin/ps', ['-E', '-ww', '-p', String(pid), '-o', 'command=']);
  return shown.status === 0 ? /(?:^|\s)__CFBundleIdentifier=(\S+)/u.exec(String(shown.stdout))?.[1] ?? null : null;
}

/**
 * Each live resident board process of the checkout at `cwd`.
 *
 * @param {string} cwd
 * @param {{ run?: (command: string, args: string[]) => { status: number | null, stdout: string }, alive?: (pid: number) => boolean }} [ports]
 * @returns {{ name: string, pid: number, appBundle: string | null, launchd: boolean }[]}
 */
export function residentDaemons(cwd, { run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 5_000 }), alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } } } = {}) {
  const location = gitLocation(cwd);
  if (!location) return [];
  const folder = join(location.commonDir, 'pullboard');
  let files = [];
  try { files = readdirSync(folder).filter(name => /^resident-.*\.pid$/u.test(name)); } catch { return []; }
  const pids = files.map(name => ({ name, pid: Number(readFileSync(join(folder, name), 'utf8').trim()) })).filter(({ pid }) => Number.isSafeInteger(pid) && pid > 0 && alive(pid));
  if (!pids.length) return [];
  const jobs = launchdPids(run);
  return pids.map(({ name, pid }) => ({ name: `the resident board (${name.replace(/\.pid$/u, '')})`, pid, appBundle: appBundleOf(pid, run), launchd: jobs.has(pid) }));
}
