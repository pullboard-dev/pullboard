/** Shared isolated Chrome launcher with bounded startup and complete process-group cleanup [C7]. */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { join, resolve } from 'node:path';

const STARTUP_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const GROUP_POLL_MS = 20;
const STDERR_LIMIT = 128 * 1024;

/** Find an installed Chrome without making browser availability a product-test failure. */
export function findChromeExecutable() {
  return [process.env.PULLBOARD_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => candidate && existsSync(candidate));
}

/** Pause briefly while polling startup or process-group cleanup, without leaving a live timer behind. */
function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

/** Keep the most recent diagnostic bytes while continuously draining Chrome's stderr pipe. */
function appendStderr(current, chunk) {
  const next = current + chunk;
  return next.length <= STDERR_LIMIT ? next : next.slice(-STDERR_LIMIT);
}

/** Report whether the detached process group still has any members. */
function processGroupExists(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

/** Wait until a detached process group has no members, not merely until its leader exits. */
async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processGroupExists(pid)) return true;
    if (Date.now() >= deadline) break;
    await pause(Math.min(GROUP_POLL_MS, deadline - Date.now()));
  } while (Date.now() <= deadline);
  return !processGroupExists(pid);
}

/** Wait for the leader's close event with a finite bound after the whole group has exited. */
async function waitForLeaderExit(stopped, timeoutMs) {
  let timer;
  const exited = await Promise.race([stopped.then(() => true), new Promise((resolveExit) => {
    timer = setTimeout(() => resolveExit(false), timeoutMs);
  })]);
  clearTimeout(timer);
  return exited;
}

/** Stop an owned detached process group and wait for every helper before its profile may be removed. */
async function stopProcessGroup(child, stopped, timeoutMs = CLEANUP_TIMEOUT_MS) {
  const pid = child?.pid;
  if (!pid) {
    if (!await waitForLeaderExit(stopped, timeoutMs)) throw new Error('Isolated Chrome did not close after cleanup.');
    return;
  }
  if (processGroupExists(pid)) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* The owned process group already exited. */ }
  }
  if (!await waitForProcessGroupExit(pid, timeoutMs)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* The owned process group already exited. */ }
    if (!await waitForProcessGroupExit(pid, timeoutMs)) throw new Error('Isolated Chrome process group did not exit after cleanup.');
  }
  if (!await waitForLeaderExit(stopped, timeoutMs)) throw new Error('Isolated Chrome did not close after its process group exited.');
}

/** Launch an executable as a detached process group and retain its stderr and launch timing. */
export function launchChromeProcess({ executable, args = [], env = process.env, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS } = {}) {
  if (!executable) throw new Error('Chrome was not found; install Chrome or set PULLBOARD_CHROME.');
  const launchedAt = Date.now();
  const child = spawn(executable, args, { detached: true, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let launchError = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = appendStderr(stderr, chunk); });
  child.once('error', (error) => { launchError = error; });
  const stopped = new Promise((resolveStopped) => child.once('close', resolveStopped));
  let closePromise;
  /** Stop this exact process group once; callers can inspect stderr and elapsed launch time. */
  function close() {
    closePromise ??= stopProcessGroup(child, stopped, cleanupTimeoutMs);
    return closePromise;
  }
  return {
    child,
    stopped,
    close,
    get stderr() { return stderr; },
    get launchError() { return launchError; },
    get launchDurationMs() { return Date.now() - launchedAt; },
  };
}

/** Start isolated Chrome and expose navigation and evaluation methods over its local DevTools port. */
export async function startChrome({
  url = 'about:blank',
  executable = findChromeExecutable(),
  profileDirectory,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  env = process.env,
} = {}) {
  if (!executable) throw new Error('Chrome was not found; install Chrome or set PULLBOARD_CHROME.');
  const ownedProfile = !profileDirectory;
  const profile = resolve(profileDirectory ?? mkdtempSync(join(tmpdir(), 'pullboard-chrome-')));
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-proxy-server',
    '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  let launched;
  let socket;
  let id = 0;
  const pending = new Map();
  try {
    launched = launchChromeProcess({ executable, args, env, cleanupTimeoutMs });
    const deadline = Date.now() + startupTimeoutMs;
    const port = await readDevToolsPort(profile, launched, deadline);
    const target = await createPageTarget(port, deadline);
    socket = await connectDevTools(target.webSocketDebuggerUrl, deadline);
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const relayRequests = new Set();
    const send = createSender(socket, pending, () => ++id, commandTimeoutMs, loopDelay, relayRequests);
    const evaluate = createEvaluator(send);
    let closed = false;
    let taskSequence = 0;
    /** Navigate the existing isolated browser profile to a local or test-owned URL. */
    async function navigate(nextUrl) {
      await send('Page.navigate', { url: nextUrl }, 'navigate page');
    }
    /** Wait until a page expression becomes truthy, treating document-transition evaluation errors as pending. */
    async function waitFor(expression, timeoutMs = commandTimeoutMs, label = 'wait for page condition') {
      const waitDeadline = Date.now() + timeoutMs;
      let lastEvaluationError = null;
      while (Date.now() < waitDeadline) {
        try {
          if (await evaluate(expression, label)) return;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('Browser evaluation failed:')) throw error;
          lastEvaluationError = error;
        }
        await pause(50);
      }
      const exception = lastEvaluationError instanceof Error ? `; last evaluation failed: ${lastEvaluationError.message}` : '';
      throw new Error(`Browser condition "${label}" did not arrive within ${timeoutMs}ms; expression: ${expression.slice(0, 200)}${exception}.`);
    }
    /** Start asynchronous page work without holding a CDP Runtime.evaluate command open. */
    async function startTask(expression, label) {
      const taskId = '__pullboardFixtureTask' + ++taskSequence;
      const key = JSON.stringify(taskId);
      await evaluate(`(() => { window[${key}] = null; Promise.resolve().then(() => (${expression}))
        .then(value => { window[${key}] = { value }; }, error => { window[${key}] = { error: { code: error?.code ?? null, message: error?.message ?? 'page operation failed' } }; }); return true; })()`, label);
      return taskId;
    }
    /** Poll asynchronous page work while each DevTools command stays short. */
    async function pollTask(taskId, timeoutMs = 25_000, label = 'poll page operation') {
      const key = JSON.stringify(taskId);
      await waitFor(`window[${key}] !== null && window[${key}] !== undefined`, timeoutMs, label);
      const result = await evaluate(`window[${key}]`, label + ' result');
      if (result?.error) {
        const error = new Error(`${label} failed${result.error.code ? ' [' + result.error.code + ']' : ''}: ${result.error.message}`);
        if (result.error.code) error.code = result.error.code;
        throw error;
      }
      return result?.value;
    }
    /** Close once; remove an owned profile only after the full Chrome process group is gone. */
    async function close() {
      if (closed) return;
      closed = true;
      try { socket.close(); } catch { /* The DevTools socket already closed. */ }
      loopDelay.disable();
      rejectPending(pending, 'Isolated Chrome closed before a command completed.');
      await launched.close();
      if (ownedProfile) rmSync(profile, { recursive: true, force: true });
    }
    await send('Network.enable', {}, 'enable network diagnostics');
    await send('Page.enable', {}, 'enable page diagnostics');
    await send('Runtime.enable', {}, 'enable runtime diagnostics');
    await send('Page.navigate', { url }, 'open initial page');
    const launchDurationMs = launched.launchDurationMs;
    process.stderr.write(`Chrome ready in ${launchDurationMs}ms (${startupTimeoutMs}ms DevTools budget)\n`);
    return {
      profileDirectory: profile,
      launchDurationMs,
      get stderr() { return launched.stderr; },
      navigate,
      evaluate,
      waitFor,
      startTask,
      pollTask,
      send,
      close,
    };
  } catch (error) {
    socket?.close();
    rejectPending(pending, 'Isolated Chrome stopped before startup completed.');
    const launchDurationMs = launched?.launchDurationMs ?? 0;
    const stderr = launched?.stderr?.trimEnd();
    let cleanupFailure = null;
    try { await launched?.close(); }
    catch (cleanupError) { cleanupFailure = cleanupError; }
    if (!cleanupFailure && ownedProfile) rmSync(profile, { recursive: true, force: true });
    const message = sanitizeStartupError(error);
    const cleanup = cleanupFailure ? `\n${cleanupFailure.message}; profile retained until the process group exits` : '';
    throw new Error(`${message.message} (elapsed ${launchDurationMs}ms; ${startupTimeoutMs}ms DevTools budget)${stderr ? `\nChrome stderr:\n${stderr}` : ''}${cleanup}`);
  }
}

/** Read Chrome's ephemeral debugging port and stop waiting when its leader exits or deadline passes. */
async function readDevToolsPort(profile, launched, deadline) {
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    } catch { /* Chrome has not published the local DevTools port yet. */ }
    if (launched.launchError) throw new Error('Isolated Chrome could not start.');
    if (launched.child.exitCode !== null || launched.child.signalCode !== null) throw new Error('Isolated Chrome exited during startup.');
    await pause(50);
  }
  throw new Error('Isolated Chrome did not publish its DevTools port.');
}

/** Create one blank page target without exceeding the shared startup deadline. */
async function createPageTarget(port, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT', signal: AbortSignal.timeout(remaining),
  });
  if (!response.ok) throw new Error('Isolated Chrome did not create a page target.');
  const target = await response.json();
  if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('Isolated Chrome returned no page target.');
  return target;
}

/** Open the local DevTools WebSocket without echoing its URL or response data. */
async function connectDevTools(debuggerUrl, deadline) {
  const socket = new WebSocket(debuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => rejectOpen(new Error('DevTools socket did not open.')), remaining);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('DevTools socket failed.')); }, { once: true });
  });
  return socket;
}

/** Create a CDP command sender that correlates responses and bounds every request. */
function createSender(socket, pending, nextId, timeoutMs, loopDelay, relayRequests) {
  /** Resolve or reject the request matching one CDP response without logging its payload. */
  function onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) relayRequests.clear();
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params?.request;
      const url = request?.url ?? '';
      const eventStream = /\/api\/v1\/boards\/[0-9a-f]{32}\/events(?:\?|$)/.test(url)
        && /text\/event-stream/i.test(request?.headers?.Accept ?? request?.headers?.accept ?? '');
      if (/\/api\/v1\/boards\//.test(url) && !eventStream) relayRequests.add(message.params.requestId);
    }
    if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
      relayRequests.delete(message.params?.requestId);
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`DevTools command failed: ${waiter.method}.`));
    else waiter.resolve(message.result);
  }
  socket.addEventListener('message', onMessage);
  return (method, params = {}, label = method) => new Promise((resolveResult, rejectResult) => {
    const requestId = nextId();
    const startedAt = Date.now();
    const maxDelayAtSend = loopDelay.max;
    const timeoutMessage = () => {
      const maxDelayRise = Math.max(0, loopDelay.max - maxDelayAtSend);
      return `DevTools ${method} "${label}" timed out after ${Date.now() - startedAt}ms; maximum event-loop delay ${Math.round(maxDelayRise / 1e6)}ms; relay request pending: ${relayRequests.size > 0}.`;
    };
    const timer = setTimeout(() => {
      pending.delete(requestId);
      rejectResult(new Error(timeoutMessage()));
    }, timeoutMs);
    pending.set(requestId, { resolve: resolveResult, reject: rejectResult, timer, method, label });
    try { socket.send(JSON.stringify({ id: requestId, method, params })); }
    catch {
      clearTimeout(timer);
      pending.delete(requestId);
      rejectResult(new Error(`DevTools command could not be sent: ${method}.`));
    }
  });
}

/** Evaluate a page expression by value and retain bounded diagnostics for page exceptions. */
function createEvaluator(send) {
  return async (expression, label = 'evaluate page expression') => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, label);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const exception = details.exception;
      const description = exception?.description || (exception && Object.hasOwn(exception, 'value')
        ? String(exception.value) : (details.text || 'page expression threw'));
      const frame = details.stackTrace?.callFrames?.[0];
      const lineNumber = Number.isInteger(frame?.lineNumber) ? frame.lineNumber : details.lineNumber;
      const columnNumber = Number.isInteger(frame?.columnNumber) ? frame.columnNumber : details.columnNumber;
      const line = Number.isInteger(lineNumber) ? lineNumber + 1 : 'unknown';
      const column = Number.isInteger(columnNumber) ? columnNumber + 1 : 'unknown';
      throw new Error(`Browser evaluation failed: ${description} (line ${line}, column ${column}); expression: ${expression.slice(0, 200)}`);
    }
    return result.result?.value;
  };
}

/** Reject outstanding CDP requests during close or startup failure without exposing payloads. */
function rejectPending(pending, message) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(message));
  }
  pending.clear();
}

/** Replace implementation-specific startup errors with safe diagnostic text. */
function sanitizeStartupError(error) {
  if (error instanceof Error && /Chrome|DevTools|page target/.test(error.message)) return error;
  return new Error('Isolated Chrome could not start or connect to its local DevTools endpoint.');
}
