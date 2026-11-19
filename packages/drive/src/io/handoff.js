/** A served process hands its listening socket to its replacement on new code, so the port is never unanswered [C7,#6723]. */
import { tracingChannel } from 'node:diagnostics_channel';
import { closeSync } from 'node:fs';
import { openSync } from 'node:fs';
import { Server } from 'node:net';
import { environmentAdapter } from '../../../env/index.js';
import { spawnDetachedChild } from '../../../jobs/index.js';

/** The variable that tells a replacement its predecessor's listening socket is its descriptor 3. */
export const SERVE_FD_ENV = 'PULLBOARD_SERVE_FD';
/** The descriptor a replacement finds the handed socket on. */
const HANDED_FD = 3;
/** How long a replacement has to say it listens before it is stopped and the old process keeps serving. */
const LISTEN_WAIT_MS = 60_000;

/**
 * Run `start` and answer its value with `socketFd(port)`, the descriptor of the server `start` opened listening on
 * that port (null where it cannot be handed on: Windows, or no such server), and `drain(port)`, which stops that
 * server accepting and settles once every connection it holds has had its requests answered and closed.
 * Why: the listening server is built deep inside the API, and the restart path takes its socket without reaching in.
 *
 * @template T
 * @param {() => Promise<T>} start
 * @returns {Promise<{ value: T, socketFd: (port: number) => number | null, drain: (port: number) => Promise<void> }>}
 */
export async function catchListeners(start) {
  const servers = [];
  const channel = tracingChannel('net.server.listen');
  const handlers = { start() {}, end() {}, asyncStart() {}, error() {}, asyncEnd: ({ server }) => { servers.push(server); } };
  channel.subscribe(handlers);
  try {
    const value = await start();
    const on = (port) => servers.find((server) => server.address()?.port === port);
    return { value, socketFd: (port) => descriptor(on(port)), drain: (port) => drain(on(port)) };
  } finally { channel.unsubscribe(handlers); }
}

/**
 * Stop accepting without dropping a connection: every request still to come on a held connection is answered with
 * Connection: close, and the promise settles when the last connection ends.
 * Why: http's own close also destroys connections with no request in flight, including one just accepted whose
 * request is still on the wire and a keep-alive one a client is about to reuse; each of those is a reset request.
 */
function drain(server) {
  if (!server) return Promise.resolve();
  server.prependListener('request', (_, res) => { if (!res.headersSent) res.setHeader('connection', 'close'); });
  return new Promise((done) => { Server.prototype.close.call(server, () => done()); });
}

/** A listening server's own descriptor, or null. */
function descriptor(server) {
  const fd = /** @type {any} */ (server)?._handle?.fd;
  return process.platform !== 'win32' && Number.isInteger(fd) && fd > 2 ? fd : null;
}

/**
 * The listen target a replacement takes, `{ fd: 3 }`, when its predecessor handed it a socket; else null. It reads the
 * variable once and clears it, so nothing this process starts inherits the claim.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ fd: number } | null}
 */
export function inheritedListener(env) {
  const environment = environmentAdapter(env);
  const handed = environment.get(SERVE_FD_ENV) === String(HANDED_FD);
  environment.delete(SERVE_FD_ENV);
  return handed ? { fd: HANDED_FD } : null;
}

/** Tell the predecessor this replacement listens, so it may stop accepting; a process nobody started this way says nothing. */
export function announceListening() {
  if (typeof process.send !== 'function') return;
  process.send('listening');
  process.channel?.unref();
}

/**
 * Start `command args` as a detached replacement holding the listening socket `fd` as its descriptor 3, and answer once
 * it says it listens. A replacement that exits, fails to start, or stays silent for `wait` ms answers listening false
 * and is stopped, so the caller keeps serving. The caller keeps its own copy of the socket until it closes it.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ fd: number, cwd?: string, env?: NodeJS.ProcessEnv, log?: string, wait?: number }} options log is a file for both output streams.
 * @returns {Promise<{ pid: number | null, listening: boolean }>}
 */
export function spawnOnSocket(command, args, { fd, cwd = process.cwd(), env = environmentAdapter().all(), log, wait = LISTEN_WAIT_MS }) {
  let out = 'ignore';
  try {
    if (log) out = openSync(log, 'a', 0o600);
    const child = spawnDetachedChild(command, args, { cwd, env: { ...env, [SERVE_FD_ENV]: String(HANDED_FD) }, stdio: ['ignore', out, out, fd, 'ipc'] });
    return new Promise((done) => {
      const finish = (listening) => {
        clearTimeout(timer);
        child.off('message', said); child.off('error', failed); child.off('exit', failed);
        if (!listening && child.exitCode === null && child.signalCode === null) child.kill();
        if (child.connected) child.disconnect();
        child.unref();
        done({ pid: child.pid ?? null, listening });
      };
      const said = (message) => { if (message === 'listening') finish(true); };
      const failed = () => finish(false);
      const timer = setTimeout(failed, wait);
      child.on('error', () => {}); // a late spawn error after the answer is no crash for the serving process
      child.on('message', said); child.once('error', failed); child.once('exit', failed);
    });
  } catch { return Promise.resolve({ pid: null, listening: false }); }
  finally { if (typeof out === 'number') closeSync(out); }
}
