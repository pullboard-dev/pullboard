/** One long-lived shell on a runner that every gate on that runner shares, one short request at a time [C7]. */
import { randomUUID } from 'node:crypto';
import { Refused } from '../../../kernel/light.js';
import { readReply } from '../logic/frames.js';
import { requestFrame } from '../logic/frames.js';

// Budget: a channel request is a short shell step (start a shard, read a file); long work runs detached on the runner.
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Wrap an opened shell process as a channel: run(script) queues one framed request and resolves with its status and
 * output; the first exit, error or wedged request marks the channel lost and fails everything still queued.
 *
 * Why: requests are serialised on the one shell, so replies never interleave; work that must run in parallel is
 * started detached by its request and read back later from files.
 *
 * @param {{ runner: object, child: import('node:child_process').ChildProcess, timeoutMs?: number }} options
 * @returns {object} The channel.
 */
export function openChannel({ runner, child, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const lostListeners = new Set();
  let buffer = Buffer.alloc(0);
  let pending = null;
  let tail = Promise.resolve();
  let lost = null;
  let requests = 0;

  /** Fail the request in flight and every later one with the reason the channel ended. */
  const lose = reason => {
    if (lost) return;
    lost = new Refused('TRANSPORT_LOST', `the channel to runner ${runner.host} ended: ${reason}; connect again for a fresh channel`);
    if (pending) { clearTimeout(pending.timer); pending.reject(lost); pending = null; }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const listener of lostListeners) {
      try { listener(lost); } catch { /* A listener's own failure never stops the others hearing the loss. */ }
    }
  };

  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!pending) return;
    const reply = readReply(buffer, pending.nonce);
    if (!reply) return;
    buffer = Buffer.from(reply.rest);
    const { resolve, timer } = pending;
    pending = null;
    clearTimeout(timer);
    resolve({ status: reply.status, output: Buffer.from(reply.output) });
  });
  child.stderr?.on('data', () => {});
  child.stdin.on('error', error => lose(`stdin ${error.code ?? error.message}`));
  child.once('error', error => lose(error.code ?? error.message));
  child.once('exit', (status, signal) => lose(signal ? `signal ${signal}` : `exit ${status}`));

  /** Send one request once the one before it has answered. */
  const send = (script, limit) => new Promise((resolve, reject) => {
    if (lost) return reject(lost);
    const nonce = randomUUID().replaceAll('-', '');
    const timer = setTimeout(() => lose(`a request gave no reply within ${limit} ms`), limit);
    pending = { nonce, resolve, reject, timer };
    requests += 1;
    child.stdin.write(requestFrame(nonce, script));
  });

  return {
    runner,
    pid: child.pid,
    /** Run one POSIX shell script on the runner; resolves { status, output } or rejects TRANSPORT_LOST. */
    run(script, { timeoutMs: limit = timeoutMs } = {}) {
      const turn = tail.then(() => send(script, limit));
      tail = turn.catch(() => {});
      return turn;
    },
    /** True until the channel's shell ends. */
    get alive() { return !lost; },
    /** How many requests this channel has carried, for callers that measure sharing. */
    get requests() { return requests; },
    /** Call back once with the TRANSPORT_LOST refusal when the channel ends; returns an unsubscribe. */
    onLost(listener) {
      if (lost) { listener(lost); return () => {}; }
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    /** End the channel's shell. */
    close() { if (!lost) { child.stdin.end(); lose('closed'); } },
  };
}
