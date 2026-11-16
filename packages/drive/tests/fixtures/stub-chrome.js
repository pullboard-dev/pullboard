/** Stand-in Chrome processes for the leftover-sweep tests: real, detached or orphaned, so the cleanup is proved on live pids [C7,#7812]. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** A stand-in for Chrome: it prints its pid, names its profile in its arguments, hides its environment from any marker, and ignores SIGTERM as a hung helper does. */
const STUB = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
/** Spawns the stub detached and exits, so init owns the stub while it keeps this process's stdout pipe open. */
const LAUNCHER = "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', process.env.STUB_CODE, '--', process.env.STUB_ARG], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();";

/** Whether a pid is still a live process. */
export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Start a stub whose command line names `profile` after `flag`; `orphaned` leaves it parentless, as a killed serve's job does.
 * `env` adds environment variables, which the orphaned stub keeps, as a local runner keeps its TMPDIR.
 * `closed` settles once the stub is gone, because it holds the pipe the test reads its pid from.
 */
export async function stub(profile, orphaned = false, flag = '--user-data-dir=', env = {}) {
  const arg = `${flag}${profile}`;
  const child = orphaned ? spawn(process.execPath, ['-e', LAUNCHER], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, STUB_CODE: STUB, STUB_ARG: arg, ...env } })
    : spawn(process.execPath, ['-e', STUB, '--', arg], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const launched = orphaned ? once(child, 'exit') : null, closed = once(child, 'close');
  const [first] = await once(child.stdout, 'data');
  child.stdout.resume();
  await launched;
  return { pid: Number(String(first).trim()), closed };
}
