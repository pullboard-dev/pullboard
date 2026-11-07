/** The runner connection registry: connect(runner) reuses one live channel per runner; probe is its own call [C7]. */
import { channelKey } from '../core/frames.js';
import { openChannel } from './channel.js';
import { sshLaunch } from './ssh.js';
import { sshOpen } from './ssh.js';

// Budget: a probe proves the runner answers at all; two seconds of ssh connect plus a trivial reply.
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_TOKEN = 'PULLBOARD_PROBE_OK';

/**
 * Build a transport over process adapters: open(runner) starts the remote shell a channel wraps; launch(runner,
 * script) runs one short script apart from any channel.
 *
 * Why: every gate on a runner shares one channel, so the Mac holds one process per runner instead of one controller
 * and ssh session per gate; the probe never rides the channel, so a busy or wedged channel cannot fake a healthy
 * runner and a failed probe never ends the gates still using it.
 *
 * @param {{ open?: (runner: object) => import('node:child_process').ChildProcess,
 *   launch?: (runner: object, script: string) => import('node:child_process').ChildProcess,
 *   now?: () => number, timeoutMs?: number, probeTimeoutMs?: number }} [adapters]
 * @returns {{ connect: Function, probe: Function, channels: Function, close: Function }}
 */
export function createTransport({ open = sshOpen, launch = sshLaunch, now = Date.now, timeoutMs, probeTimeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const live = new Map();

  /** The runner's live channel, opened on first use and replaced only after it is lost. */
  function connect(runner) {
    const key = channelKey(runner);
    const existing = live.get(key);
    if (existing?.alive) return existing;
    const channel = openChannel({ runner, child: open(runner), ...(timeoutMs ? { timeoutMs } : {}) });
    live.set(key, channel);
    channel.onLost(() => { if (live.get(key) === channel) live.delete(key); });
    return channel;
  }

  /** Ask the runner, over its own short call, whether it answers; resolves { ok, host, at, ms, reason }. */
  function probe(runner) {
    const host = channelKey(runner);
    const at = now();
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
  }

  return {
    connect,
    probe,
    /** The live channels, one per runner host. */
    channels: () => [...live.values()],
    /** Close every live channel. */
    close() { for (const channel of [...live.values()]) channel.close(); live.clear(); },
  };
}

let shared = null;

/** The process-wide transport over ssh, made on first use so importing the cell starts nothing. */
export function sharedTransport() {
  shared ??= createTransport();
  return shared;
}

/** The runner's one reused channel on the process-wide transport. */
export function connect(runner) {
  return sharedTransport().connect(runner);
}

/** A probe of the runner on the process-wide transport, separate from its channel. */
export function probe(runner) {
  return sharedTransport().probe(runner);
}
