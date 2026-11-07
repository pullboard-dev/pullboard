/** The SSH push adapter: a registered machine's channel is one ssh session running `sh`; its probe is its own call [C7]. */
import { spawn } from 'node:child_process';
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

/** Start the runner's shared shell: one ssh session whose remote command is a plain POSIX shell. */
function sshShell(runner) {
  return spawn('ssh', [...SSH_OPTIONS, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '--', runner.host, 'sh'], { env: sshEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Launch one short script on the runner over its own ssh call, apart from the channel. */
function sshLaunch(runner, script) {
  return spawn('ssh', [...SSH_OPTIONS, '-o', 'ConnectTimeout=5', '--', runner.host, script],
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
