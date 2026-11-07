/** The default process adapters: a channel is one ssh session running `sh`, a probe is its own short ssh call [C7]. */
import { spawn } from 'node:child_process';

// These are transport hang ceilings, independent of any command's execution budget.
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'SendEnv=-*'];

/** The credential-free environment an ssh client needs, and nothing else from this process. */
function sshEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

/**
 * Open the runner's shared channel: one ssh session whose remote command is a plain POSIX shell.
 *
 * @param {{ host: string }} runner
 * @returns {import('node:child_process').ChildProcess}
 */
export function sshOpen(runner) {
  return spawn('ssh', [...SSH_OPTIONS, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '--', runner.host, 'sh'], { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Launch one short script on the runner over its own ssh call, apart from the channel.
 *
 * @param {{ host: string }} runner
 * @param {string} script
 * @returns {import('node:child_process').ChildProcess}
 */
export function sshLaunch(runner, script) {
  return spawn('ssh', [...SSH_OPTIONS, '-o', 'ConnectTimeout=5', '--', runner.host, script],
    { env: sshEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
}
