/** Start a long-lived Pullboard process that can reach the runners on the LAN, whichever app ran the command [C7,#5699]. */
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { openSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

/** The launchd label prefix of every process started here; the next launch boots out jobs whose process ended. */
export const LAUNCH_LABEL_PREFIX = 'dev.pullboard.daemon.';
/** The launchd control tool; where it exists the process starts as a launchd job. */
const LAUNCHCTL = '/bin/launchctl';
/** How long to wait for launchd to report the started process. */
const START_WAIT_MS = 3_000;

/** Escape one string for a property list. */
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The property list of a one-shot launchd job running `argv` once, with the given folder, environment and log. */
export function launchJobPlist(label, argv, { cwd, env = {}, log } = {}) {
  const strings = items => items.map(item => `<string>${xml(item)}</string>`).join('');
  const variables = Object.entries(env).filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string>`
    + `<key>ProgramArguments</key><array>${strings(argv)}</array>`
    + (cwd ? `<key>WorkingDirectory</key><string>${xml(cwd)}</string>` : '')
    + `<key>EnvironmentVariables</key><dict>${variables}</dict>`
    + (log ? `<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>` : '')
    + '<key>RunAtLoad</key><true/><key>AbandonProcessGroup</key><true/></dict></plist>\n';
}

/** Run launchctl and answer its exit status and output; it never throws. */
function launchctl(args) {
  return new Promise(resolve => execFile(LAUNCHCTL, args, { encoding: 'utf8', timeout: 5_000 },
    (error, stdout) => resolve({ status: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: stdout ?? '' })));
}

/** The pid launchd reports for a loaded job, or null while it has none. */
async function jobPid(domain, label) {
  const pid = /^\s*pid = (\d+)$/mu.exec((await launchctl(['print', `${domain}/${label}`])).stdout)?.[1];
  return pid ? Number(pid) : null;
}

/** Boot out jobs whose process has ended and remove their files; a running job is left alone. */
async function sweep(folder, domain) {
  let names = [];
  try { names = readdirSync(folder).filter(name => name.startsWith(LAUNCH_LABEL_PREFIX) && name.endsWith('.plist')); } catch { return; }
  for (const name of names) {
    const label = name.slice(0, -'.plist'.length);
    const shown = await launchctl(['print', `${domain}/${label}`]);
    if (shown.status === 0 && /^\s*pid = \d+$/mu.test(shown.stdout)) continue;
    if (shown.status === 0) await launchctl(['bootout', `${domain}/${label}`]);
    try { unlinkSync(join(folder, name)); } catch { /* Another sweep removed it. */ }
  }
}

/**
 * Start `command args` detached so it can open LAN connections; returns its pid, or null when it did not start.
 * Where launchd runs (macOS) it runs as a one-shot launchd job, so launchd is its responsible process and the Local Network permission
 * of the app that ran the command does not apply; the returned pid is the process itself, and a later launch boots
 * the finished job out. Without launchd, or when
 * launchd refuses, it is a plain detached spawn. Why: on 11 Nov a lander started from a ChatGPT-hosted seat inherited
 * ChatGPT's denied Local Network permission; every ssh it opened failed "No route to host" and nothing landed [C7].
 *
 * @param {string} command - The executable.
 * @param {string[]} args - Its arguments.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, log?: string, home?: string, launchd?: boolean }} [options] - log is a file path for both output streams; launchd false forces the plain spawn.
 * @returns {Promise<{ pid: number | null, launchd: boolean, label?: string }>}
 */
export async function spawnReachable(command, args, { cwd = process.cwd(), env = process.env, log, home = process.env.PULLBOARD_MACHINE_HOME ?? join(homedir(), '.pullboard'), launchd = existsSync(LAUNCHCTL) } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const started = launchd && uid !== null ? await launched(command, args, { cwd, env, log, home, uid }) : null;
  return started ?? detached(command, args, { cwd, env, log });
}

/** Load a one-shot launchd job running the command and answer its pid, or null when launchd refused it. */
async function launched(command, args, { cwd, env, log, home, uid }) {
  const domain = `gui/${uid}`, folder = join(home, 'launchd'), label = LAUNCH_LABEL_PREFIX + randomUUID();
  const file = join(folder, `${label}.plist`);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    await sweep(folder, domain);
    writeFileSync(file, launchJobPlist(label, [command, ...args], { cwd, env, log }), { mode: 0o600 });
    if ((await launchctl(['bootstrap', domain, file])).status !== 0) { unlinkSync(file); return null; }
  } catch { return null; }
  const until = Date.now() + START_WAIT_MS;
  let pid = await jobPid(domain, label);
  while (pid === null && Date.now() < until) { await pause(20); pid = await jobPid(domain, label); }
  return { pid, launchd: true, label };
}

/** Start the command as a plain detached child that keeps its log, and answer its pid. */
function detached(command, args, { cwd, env, log }) {
  let out = 'ignore';
  try {
    if (log) out = openSync(log, 'a', 0o600);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', out, out] });
    child.once('error', () => {});
    child.unref();
    return { pid: child.pid ?? null, launchd: false };
  } catch { return { pid: null, launchd: false }; }
  finally { if (typeof out === 'number') closeSync(out); }
}
