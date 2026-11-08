/** The SSH push adapter: a registered machine's channel is one ssh session running `sh`; its probe is its own call; all share one multiplexed connection per runner [C7]. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { openChannel } from './channel.js';
import { sshFetchResult } from './ssh-shards.js';
import { sshResetShard } from './ssh-shards.js';
import { sshStartShard } from './ssh-shards.js';

// These are transport hang ceilings, independent of any command's execution budget.
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'SendEnv=-*'];
// Budget: a probe proves the runner answers at all; ssh connect plus a trivial reply.
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_TOKEN = 'PULLBOARD_PROBE_OK';

/** The credential-free environment an ssh client needs, and nothing else from this process. */
function sshEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

// One TCP connection per runner: every ssh call to a runner rides its control master (#3658). The master lives
// ControlPersist seconds past its last session, so a burst of gate sessions costs one handshake, not one per file.
const CONTROL_PERSIST_S = 60;
// The master's own transport ceilings: connect, then notice a dead peer within 30 s.
const MASTER_OPTIONS = '-T -o BatchMode=yes -o ForwardAgent=no -o ClearAllForwardings=yes -o "SendEnv=-*" '
  + '-o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3';
// A Unix socket path is limited to 104 bytes on macOS, so the shell runs in the socket's folder and names it relatively.
// One shell per call: if no live master answers, take a per-runner lock (a mkdir, shared across processes), start the
// master once in the background, then exec the real session over it. Waiters poll the socket for up to 15 s; a
// lock older than a minute is a dead holder's and is removed. If the master cannot start, ssh connects directly.
const MULTIPLEX_SCRIPT = [
  'd=$1; p=$2; h=$3; shift 3; held=',
  'cd "$d" 2>/dev/null || exec ssh "$@"',
  'up() { ssh -o ControlPath="$p" -O check -- "$h" </dev/null >/dev/null 2>&1; }',
  'if ! up; then',
  '  trap \'[ -n "$held" ] && rmdir "$p.lock" 2>/dev/null; exit 143\' TERM INT HUP',
  '  n=0',
  '  until mkdir "$p.lock" 2>/dev/null && held=1; do',
  '    [ -n "$(find "$p.lock" -prune -mmin +1 2>/dev/null)" ] && rmdir "$p.lock" 2>/dev/null',
  '    [ -e "$p" ] && up && break',
  '    n=$((n+1)); [ "$n" -ge 150 ] && break',
  '    sleep 0.1',
  '  done',
  '  if [ -n "$held" ]; then',
  `    up || { rm -f "$p"; ssh -f -N -o ControlMaster=yes -o ControlPath="$p" -o ControlPersist=${CONTROL_PERSIST_S} ${MASTER_OPTIONS} -- "$h" </dev/null >/dev/null 2>&1; }`,
  '    rmdir "$p.lock" 2>/dev/null; held=',
  '  fi',
  '  trap - TERM INT HUP',
  'fi',
  'exec ssh -o ControlMaster=no -o ControlPath="$p" "$@"',
].join('\n');

/**
 * The control socket for one runner: a hash of its destination under the machine home's ssh folder, so every
 * Pullboard process on this machine shares one master per runner. Null when there is no usable machine home.
 *
 * @param {string} host - The runner's ssh destination.
 * @param {{ home?: string }} [options] - The machine home; defaults to PULLBOARD_MACHINE_HOME or ~/.pullboard.
 * @returns {string|null}
 */
export function sshControlPath(host, { home = process.env.PULLBOARD_MACHINE_HOME ?? join(homedir(), '.pullboard') } = {}) {
  if (typeof host !== 'string' || !host || process.platform === 'win32' || !isAbsolute(home ?? '')) return null;
  const folder = join(home, 'ssh');
  const path = join(folder, createHash('sha256').update(host).digest('hex').slice(0, 12));
  try { mkdirSync(folder, { recursive: true, mode: 0o700 }); } catch { return null; }
  return path;
}

/**
 * Spawn one ssh call to a runner over the runner's shared multiplexed connection. `args` are the call's own ssh
 * arguments ending in `--`, the destination and the remote command; the child is asynchronous and behaves like a
 * plain ssh child (it execs ssh once the master is up), so callers keep their pipes, timers and kill paths.
 * Every Pullboard ssh call to a registered runner goes through here [C7].
 *
 * @param {string[]} args - ssh arguments: options, then `--`, the destination and the remote command.
 * @param {import('node:child_process').SpawnOptions} [options] - spawn options; `env.PATH` locates ssh.
 * @param {{ home?: string }} [where] - The machine home holding the control sockets (tests pass a private one).
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnSsh(args, options = {}, where = {}) {
  const at = args.indexOf('--');
  const path = at >= 0 ? sshControlPath(args[at + 1], where) : null;
  if (!path) return spawn('ssh', args, options);
  return spawn('/bin/sh', ['-c', MULTIPLEX_SCRIPT, 'pullboard-ssh', dirname(path), basename(path), args[at + 1], ...args], options);
}

/** Start the runner's shared shell: one ssh session whose remote command is a plain POSIX shell. */
function sshShell(runner) {
  return spawnSsh([...SSH_OPTIONS, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '--', runner.host, 'sh'], { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Launch one short script on the runner over its own ssh call, apart from the channel. */
function sshLaunch(runner, script) {
  return spawnSsh([...SSH_OPTIONS, '-o', 'ConnectTimeout=5', '--', runner.host, script],
    { env: sshEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Build the SSH push adapter. Every SSH and shell detail lives here; the transport front door sees only a channel
 * (startShard, fetchResult, resetShard, alive, onLost, close) and a probe.
 *
 * @param {{ open?: (runner: object) => import('node:child_process').ChildProcess,
 *   launch?: (runner: object, script: string) => import('node:child_process').ChildProcess,
 *   now?: () => number, timeoutMs?: number, probeTimeoutMs?: number }} [processes] - Process seams; tests pass a local `sh`.
 * @returns {{ kind: 'ssh', open: (runner: object) => object, probe: (runner: object) => Promise<object> }}
 */
export function sshAdapter({ open = sshShell, launch = sshLaunch, now = Date.now, timeoutMs, probeTimeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return {
    kind: 'ssh',
    /** Open the runner's one channel over a fresh ssh shell. */
    open(runner) {
      const shell = openChannel({ runner, child: open(runner), ...(timeoutMs ? { timeoutMs } : {}) });
      return Object.assign(shell, {
        startShard: spec => sshStartShard(shell, spec),
        fetchResult: spec => sshFetchResult(shell, spec),
        resetShard: ids => sshResetShard(shell, ids),
      });
    },
    /** Ask the runner, over its own short ssh call, whether it answers; resolves { ok, host, at, ms, reason }. */
    probe(runner) {
      const host = runner.host, at = now();
      return new Promise(resolve => {
        let child, output = '', settled = false;
        const finish = (ok, reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve({ ok, host, at, ms: now() - at, ...(reason ? { reason } : {}) });
        };
        const timer = setTimeout(() => finish(false, `no reply within ${probeTimeoutMs} ms`), probeTimeoutMs);
        try { child = launch(runner, `printf '%s\\n' ${PROBE_TOKEN}`); }
        catch (error) { return finish(false, error.code ?? error.message); }
        child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
        child.stderr?.on('data', () => {});
        child.once('error', error => finish(false, error.code ?? error.message));
        child.once('close', (status, signal) => {
          if (status === 0 && output.split('\n').includes(PROBE_TOKEN)) finish(true);
          else finish(false, signal ? `signal ${signal}` : `exit ${status}`);
        });
      });
    },
  };
}
