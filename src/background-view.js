/**
 * Keep `pullboard view` running in the background [H5,N26].
 *
 * pullboard.dev reads this computer's boards from the view on 127.0.0.1:4890, so a newcomer who
 * never typed `pullboard view` would meet an empty page. `pullboard init` and `pullboard resume`
 * therefore start the view detached when none is running, with its own log. A running view is
 * left alone, a busy port is one line and never a failure, and the machine setting
 * `view.background` (on unless set to false) turns it off.
 */
import { spawn } from './windows-child-process.js';
import {
  closeSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLocal } from './local-fetch.js';
import { Refused } from './refused.js';
import { registryFile } from './projects.js';
import {
  HOSTED_ORIGIN,
  LOOPBACK,
} from './serve.js';
import { defaultViewPort } from './view-port.js';
import {
  portHolder,
  runningView,
} from './view-session.js';
import {
  machineSettingsFile,
  viewBackgroundEnabled,
} from './settings.js';

const BIN = fileURLToPath(new URL('../bin/pullboard.js', import.meta.url));

/** The environment opt-out, for a process tree that must never leave a view behind (test runs). */
export const BACKGROUND_ENV = 'PULLBOARD_VIEW_BACKGROUND';

/** The exact stop action for a view process on this platform. */
export function stopCommand(pid) {
  return process.platform === 'win32' ? `taskkill /PID ${pid} /T` : `kill ${pid}`;
}

/** Print a live or reused view link and the exact stop action for its owning process. */
export function reportView(io, view) {
  io.result?.({ url: view.url, port: view.port, pid: view.pid, boundAt: view.boundAt, reused: view.reused, ...(view.lan ? { lan: true } : {}) });
  io.say(`Pullboard view: ${view.url}`);
  io.say(view.lan
    ? `Devices on the local network can reach it using this private link. To stop it: ${stopCommand(view.pid)}`
    : `Only this machine can reach it, and only with that link. To stop it: ${stopCommand(view.pid)}`);
}

/**
 * Spawn a detached `pullboard view` child and wait for its bind over IPC. The child is the plain
 * foreground view (PULLBOARD_VIEW_BACKGROUND_CHILD), so it records its own private session.
 *
 * @param {{ args: string[], cwd: string, stdio: any[] }} options
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, view: any }>}
 */
function startDetachedView({ args, cwd, stdio }) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', ...args], {
    cwd,
    env: { ...process.env, PULLBOARD_VIEW_BACKGROUND_CHILD: '1' },
    detached: true,
    stdio,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (part) => { stderr += part; });
  return new Promise((resolveStartup, rejectStartup) => {
    let settled = false;
    const finish = (error, view) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) return resolveStartup({ child, view });
      child.kill('SIGTERM');
      rejectStartup(error);
    };
    const timer = setTimeout(() => finish(new Refused('VIEW_START', 'the view did not bind in time; run pullboard view in the foreground for details')),
      35_000); // budget: the 30s registry lock ceiling plus 5s for local bind and IPC delivery.
    child.on('message', (message) => {
      if (message?.type === 'ready') finish(null, message);
      else if (message?.type === 'startup-error') {
        const prefix = `[${message.code}] `;
        finish(new Refused(message.code, message.message.startsWith(prefix) ? message.message.slice(prefix.length) : message.message));
      }
    });
    child.once('error', (error) => finish(new Refused('VIEW_START', `could not start the view: ${error.message}`)));
    child.once('exit', (code, signal) => {
      finish(new Refused('VIEW_START', `the view stopped before binding (exit ${code ?? signal ?? 'unknown'}): ${stderr.trim() || 'no startup details'}`));
    });
  });
}

/** Let a started child outlive this command: no pipes, no IPC channel, no reference. */
function release(child) {
  child.stderr?.destroy();
  child.unref();
  if (child.connected) child.disconnect();
}

/**
 * `pullboard view` from an agent shell or a non-terminal: start the view detached and print its
 * link, forwarding only its bound address over IPC.
 *
 * @param {any} io
 * @param {number} port
 * @param {string} [projectRoot]
 * @param {{lan?: boolean}} [options] Explicit LAN mode is never inherited by automatic init/resume startup.
 * @returns {Promise<number>}
 */
export async function launchBackgroundView(io, port, projectRoot, { lan = false } = {}) {
  const { child, view } = await startDetachedView({
    args: [...(projectRoot ? ['--project'] : []), ...(lan ? ['--lan'] : []), '--port', String(port)],
    cwd: projectRoot ?? io.cwd,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  release(child);
  reportView(io, { ...view, reused: false });
  io.flush?.(0);
  return 0;
}

/**
 * Whether something already holds this loopback port. The probe goes through the loopback-only
 * local fetch, so it can never reach past this machine. Only a refused connection means the port
 * is free: any answer, a reset or a silent listener means something holds it.
 */
async function portAnswers(port) {
  try {
    const response = await fetchLocal(`http://${LOOPBACK}:${port}/`, {
      redirect: 'manual', signal: AbortSignal.timeout(1_000), // budget: a loopback listener answers at once; a silent one is taken as held.
    });
    await response.body?.cancel();
    return true;
  } catch (error) {
    return error?.cause?.code !== 'ECONNREFUSED';
  }
}

/**
 * The background view's own log file, beside its private session record. It holds the view's
 * output, link included, so it is private to this account.
 *
 * @param {number} port
 * @returns {string}
 */
export function backgroundViewLog(port) {
  return join(dirname(registryFile()), `view-${port}.log`);
}

/**
 * Make sure a view serves this machine's boards for pullboard.dev, starting one detached when
 * none runs. Never throws: init and resume go on whatever happens here, and the outcome says
 * what to print.
 *
 * The child starts in the private home folder, outside any repository, so starting it records no
 * board's "view opened" receipt: the person has still not been shown the board.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ state: 'off' | 'running' | 'started' | 'busy' | 'failed', port?: number, pid?: number, log?: string, holder?: { pid: number, name: string } | null, message?: string }>}
 */
export async function keepViewRunning(env = process.env) {
  let port;
  try {
    if (['0', 'false', 'off'].includes(String(env[BACKGROUND_ENV] ?? '').toLowerCase()) || !viewBackgroundEnabled()) return { state: 'off' };
    port = defaultViewPort(env);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return { state: 'failed', message: error.message };
  }
  if (port === 0) return { state: 'off' };
  const existing = await runningView(port);
  if (existing) return { state: 'running', port, pid: existing.pid };
  if (await portAnswers(port)) return { state: 'busy', port, holder: portHolder(port) };
  const log = backgroundViewLog(port);
  let fd;
  try {
    mkdirSync(dirname(log), { recursive: true });
    fd = openSync(log, 'w', 0o600);
    const { child, view } = await startDetachedView({ args: ['--port', String(port)], cwd: dirname(log), stdio: ['ignore', fd, fd, 'ipc'] });
    release(child);
    return { state: 'started', port, pid: view.pid, log };
  } catch (error) {
    if (error instanceof Refused && error.code === 'PORT_BUSY') return { state: 'busy', port, holder: portHolder(port) };
    return { state: 'failed', port, log, message: error.message };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The one line init and resume print about the background view, or null when there is nothing
 * to say. Every line that names a running view says how to stop it, and names app.pullboard.dev
 * rather than the bare view address, which opens only to a refusal without the key.
 *
 * @param {Awaited<ReturnType<typeof keepViewRunning>>} outcome
 * @returns {string | null}
 */
export function backgroundViewLine(outcome) {
  const off = `turn this off with "view": { "background": false } in ${machineSettingsFile()}`;
  if (outcome.state === 'started') {
    return `Pullboard view is running in the background, so ${HOSTED_ORIGIN} finds this computer's boards (log: ${outcome.log}). To stop it: ${stopCommand(outcome.pid)}; ${off}`;
  }
  if (outcome.state === 'running') return `Pullboard view is running, so ${HOSTED_ORIGIN} finds this computer's boards. To stop it: ${stopCommand(outcome.pid)}`;
  if (outcome.state === 'busy') {
    const { holder } = outcome;
    return `Port ${outcome.port} is in use${holder ? ` by ${holder.name} (pid ${holder.pid})` : ''}, so the background view did not start, and pullboard.dev looks for your view on that port: stop ${holder ? `it with ${stopCommand(holder.pid)}` : 'the program there'}, then run pullboard resume`;
  }
  if (outcome.state === 'failed') return `The background view did not start: ${outcome.message}${outcome.log ? ` (log: ${outcome.log})` : ''}. Run pullboard view to see why`;
  return null;
}
