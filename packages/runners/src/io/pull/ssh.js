/** One short multiplexed ssh per script for pull-mode runners: node built-ins only, no per-job process kept [5465,5468]. */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pullWord } from './scripts.js';
import { environmentAdapter } from '../../../../env/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';
const fileSystem = fileSystemAdapter();

/** Output kept from one script; a runner file larger than this is an error, never a silent cut. */
export const PULL_OUTPUT_LIMIT = 64 * 1024 ** 2;

/** Machine-wide status folder: the same home rule the rest of Pullboard uses, without loading its cells. */
export function runnerStatusDir(env = environmentAdapter().all()) {
  if (env.PULLBOARD_MACHINE_HOME) return join(env.PULLBOARD_MACHINE_HOME, 'runner-status');
  if (env.PULLBOARD_ACCOUNT_HOME) return join(env.PULLBOARD_ACCOUNT_HOME, '.pullboard', 'runner-status');
  return join(homedir(), '.pullboard', 'runner-status');
}

/** Give ssh only what it needs to connect; no caller secret or repository selector is forwarded. */
function sshEnv(env = environmentAdapter().all()) {
  const kept = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR']) if (env[key] !== undefined) kept[key] = env[key];
  return { ...kept, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

/** Where the shared control socket lives: short, because a unix socket path is capped near 100 bytes. */
function controlPath(dir) {
  const base = dir.length <= 40 ? dir : `/tmp/pbcm-${process.getuid?.() ?? 0}`;
  fileSystem.mkdir(base, { recursive: true, mode: 0o700 });
  return join(base, 'cm-%C');
}

/**
 * The ssh arguments for one script: non-forwarding, batch-only, and multiplexed so enqueue, status and fetch for a
 * runner share one connection (ControlPersist keeps it a minute).
 * @param {{ host: string }} runner The runner record.
 * @param {string} script The POSIX script the runner shell runs.
 * @param {{ dir?: string, connectTimeout?: number }} [options] The status folder and the connect bound in seconds.
 * @returns {string[]} The ssh argument list.
 */
export function runnerSshArgs(runner, script, { dir = runnerStatusDir(), connectTimeout = 5 } = {}) {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'SendEnv=-*',
    '-o', `ConnectTimeout=${connectTimeout}`, '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath(dir)}`, '-o', 'ControlPersist=60',
    '--', runner.host, `/bin/sh -c ${pullWord(script)}`];
}

/**
 * Run one script on a runner over ssh and collect its answer.
 * @param {{ host: string }} runner The runner record.
 * @param {string} script The POSIX script.
 * @param {{ stdin?: string|Buffer|{ file: string }, ssh?: string, env?: object, dir?: string, timeoutMs?: number, spawnFn?: Function }} [options]
 *   `stdin` is text, bytes, or `{ file }` streamed from disk; `timeoutMs` kills a stuck ssh; `spawnFn` stands in for node's spawn in a test.
 * @returns {Promise<{ status: number|null, signal: string|null, stdout: Buffer, stderr: string, error: string|null }>} The run; never rejects.
 */
export function runRunnerScript(runner, script, { stdin = '', ssh = 'ssh', env = environmentAdapter().all(), dir = runnerStatusDir(env), timeoutMs = 30_000, spawnFn = spawn } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawnFn(ssh, runnerSshArgs(runner, script, { dir }), { env: sshEnv(env), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (failure) { resolve({ status: null, signal: null, stdout: Buffer.alloc(0), stderr: '', error: failure.code ?? failure.name }); return; }
    const out = [];
    let bytes = 0, stderr = '', error = null;
    const timer = setTimeout(() => { error ??= 'timeout'; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', part => {
      bytes += part.length;
      if (bytes > PULL_OUTPUT_LIMIT) { error ??= 'output-limit'; child.kill('SIGTERM'); } else out.push(part);
    });
    child.stderr.on('data', part => { stderr = (stderr + part.toString('utf8')).slice(-4096); });
    child.stdin.on('error', failure => { if (failure.code !== 'EPIPE') error ??= failure.code ?? failure.name; });
    child.once('error', failure => { error ??= failure.code ?? failure.name; });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout: Buffer.concat(out), stderr, error });
    });
    if (stdin && typeof stdin === 'object' && 'file' in stdin) fileSystem.createReadStream(stdin.file).on('error', failure => { error ??= failure.code ?? failure.name; child.kill('SIGTERM'); }).pipe(child.stdin);
    else child.stdin.end(stdin);
  });
}
