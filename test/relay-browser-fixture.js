/** Reusable real headless Chrome fixture for local relay browser tests. */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STARTUP_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;

/** Find an installed Chrome without making browser availability a product-test failure. */
export function findChromeExecutable() {
  return [process.env.PULLBOARD_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => candidate && existsSync(candidate));
}

/** Pause briefly while polling Chrome startup, without leaving a live timer behind. */
function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

/** Wait for the owned Chrome process to exit, bounding and clearing the timeout either way. */
async function waitForExit(stopped, timeoutMs) {
  let timer;
  const exited = await Promise.race([stopped.then(() => true), new Promise((resolveExit) => {
    timer = setTimeout(() => resolveExit(false), timeoutMs);
  })]);
  clearTimeout(timer);
  return exited;
}

/** Stop only a Chrome process group created by this fixture. */
async function stopOwnedChrome(child, stopped) {
  if (!child.pid || await waitForExit(stopped, 0)) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The owned browser already exited. */ }
  if (await waitForExit(stopped, CLEANUP_TIMEOUT_MS)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned browser already exited. */ }
  if (!await waitForExit(stopped, CLEANUP_TIMEOUT_MS)) throw new Error('Isolated Chrome did not exit after cleanup.');
}

/** Start isolated Chrome and expose safe navigation and evaluation methods over CDP. */
export async function startChrome({ url = 'about:blank', executable = findChromeExecutable(), profileDirectory } = {}) {
  if (!executable) throw new Error('Chrome was not found; install Chrome or set PULLBOARD_CHROME.');
  const ownedProfile = !profileDirectory;
  const profile = resolve(profileDirectory ?? mkdtempSync(join(tmpdir(), 'pullboard-relay-chrome-')));
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-proxy-server',
    '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  const stopped = new Promise((resolveStopped) => child.once('close', resolveStopped));
  let startupFailed = false;
  child.once('error', () => { startupFailed = true; });
  let socket;
  let id = 0;
  const pending = new Map();
  try {
    const port = await readDevToolsPort(profile, child, () => startupFailed);
    const target = await createPageTarget(port);
    socket = await connectDevTools(target.webSocketDebuggerUrl);
    const send = createSender(socket, pending, () => ++id);
    const evaluate = createEvaluator(send);
    let closed = false;
    /** Navigate the existing isolated browser profile to a local or test-owned URL. */
    async function navigate(nextUrl) {
      await send('Page.navigate', { url: nextUrl });
    }
    /** Wait until a page expression becomes truthy before its deadline. */
    async function waitFor(expression, timeoutMs = COMMAND_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await pause(50);
      }
      throw new Error('Browser condition did not arrive before its deadline.');
    }
    /** Close this browser once, stop only its process group, and remove owned profile data. */
    async function close() {
      if (closed) return;
      closed = true;
      try { socket.close(); } catch { /* The DevTools socket already closed. */ }
      rejectPending(pending, 'Isolated Chrome closed before a command completed.');
      try {
        await stopOwnedChrome(child, stopped);
      } finally {
        if (ownedProfile) rmSync(profile, { recursive: true, force: true });
      }
    }
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url });
    return { profileDirectory: profile, navigate, evaluate, waitFor, send, close };
  } catch (error) {
    socket?.close();
    rejectPending(pending, 'Isolated Chrome stopped before startup completed.');
    try {
      await stopOwnedChrome(child, stopped);
    } finally {
      if (ownedProfile) rmSync(profile, { recursive: true, force: true });
    }
    throw sanitizeStartupError(error);
  }
}

/** Read Chrome's ephemeral debugging port and fail safely if the child exits early. */
async function readDevToolsPort(profile, child, hasStartupFailed) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasStartupFailed()) throw new Error('Isolated Chrome could not start.');
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Isolated Chrome exited during startup.');
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    } catch { /* Chrome has not published the local DevTools port yet. */ }
    await pause(50);
  }
  throw new Error('Isolated Chrome did not publish its DevTools port.');
}

/** Create one blank page target without exposing browser URLs in diagnostics. */
async function createPageTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT', signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Isolated Chrome did not create a page target.');
  const target = await response.json();
  if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('Isolated Chrome returned no page target.');
  return target;
}

/** Open the local DevTools WebSocket without echoing its URL or response data. */
async function connectDevTools(debuggerUrl) {
  const socket = new WebSocket(debuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('DevTools socket did not open.')), STARTUP_TIMEOUT_MS);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('DevTools socket failed.')); }, { once: true });
  });
  return socket;
}

/** Create a CDP command sender that correlates responses and bounds every request. */
function createSender(socket, pending, nextId) {
  /** Resolve or reject the request matching one CDP response without logging its payload. */
  function onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`DevTools command failed: ${waiter.method}.`));
    else waiter.resolve(message.result);
  }
  socket.addEventListener('message', onMessage);
  return (method, params = {}) => new Promise((resolveResult, rejectResult) => {
    const requestId = nextId();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      rejectResult(new Error(`DevTools command timed out: ${method}.`));
    }, COMMAND_TIMEOUT_MS);
    pending.set(requestId, { resolve: resolveResult, reject: rejectResult, timer, method });
    try { socket.send(JSON.stringify({ id: requestId, method, params })); }
    catch {
      clearTimeout(timer);
      pending.delete(requestId);
      rejectResult(new Error(`DevTools command could not be sent: ${method}.`));
    }
  });
}

/** Evaluate a page expression by value, without including page content in failures. */
function createEvaluator(send) {
  return async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed.');
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

/** Replace implementation-specific startup errors with a diagnostic that cannot leak a URL. */
function sanitizeStartupError(error) {
  if (error instanceof Error && /Chrome|DevTools|page target/.test(error.message)) return error;
  return new Error('Isolated Chrome could not start or connect to its local DevTools endpoint.');
}
