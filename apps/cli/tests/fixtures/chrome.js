import { CHROME_GUARDIAN_SOURCE } from './chrome/shutdown.js';
import { chromeLeaderIdentity } from './chrome/shutdown.js';
import { quitOwnedChrome } from './chrome/shutdown.js';
export { stableChrome } from './cockpit/stable.js';
import { chromeLaunchArgs } from './chrome/args.js';
/** Shared isolated Chrome launcher with bounded startup and complete process-group cleanup [C7]. */
import {
  execFileSync,
  spawn as spawnGuardian,
} from 'node:child_process';
import { startFixtureChild as spawn } from './child.js';
import { privateFixtureFiles } from './child.js';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  loadavg,
  tmpdir,
} from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  join,
  resolve,
} from 'node:path';
import { browserSlotRefusal } from '../../../../packages/gate/index.js';
const STARTUP_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const GROUP_POLL_MS = 20;
const STDERR_LIMIT = 128 * 1024;

/** Find an installed Chrome without making browser availability a product-test failure; PULLBOARD_CHROME=none declares none. */
export function findChromeExecutable() {
  if (process.env.PULLBOARD_CHROME === 'none') return undefined;
  return [process.env.PULLBOARD_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => candidate && existsSync(candidate));
}

/** Pause briefly while polling startup or process-group cleanup, without leaving a live timer behind. */
function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

/** Confirm removal from Chrome's target list within one declared operation deadline. */
export async function waitForTargetAbsent(listTargets, targetId, {
  timeoutMs = 5_000, now = Date.now, pauseFor = pause,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    const targets = await listTargets(Math.max(1, deadline - now()));
    if (!targets.some(candidate => candidate.id === targetId)) return;
    if (now() >= deadline) break;
    await pauseFor(Math.max(0, Math.min(50, deadline - now())));
  } while (now() < deadline);
  throw new Error(`Closed DevTools target ${targetId} remained listed within ${timeoutMs}ms.`);
}

/** Build the shared bounded page-condition loop around the real CDP evaluator. */
export function createWaiter(evaluate, { commandTimeoutMs = COMMAND_TIMEOUT_MS, pauseFor = pause, now = Date.now,
  includeExpression = true, captureTimeout } = {}) {
  return async function waitFor(expression, timeoutMs = commandTimeoutMs, label = 'wait for page condition') {
    const waitDeadline = now() + timeoutMs;
    let lastEvaluationError = null;
    const currentLabel = () => typeof label === 'function' ? label() : label;
    while (now() < waitDeadline) {
      try {
        if (await evaluate(expression, currentLabel(), waitDeadline - now())) return;
      } catch (error) {
        if (error instanceof Error && (error.message.startsWith('Browser evaluation failed:')
          || (error.code === -32000 && error.navigated === true))) lastEvaluationError = error;
        else if (error.code !== 'CDP_TIMEOUT' || now() < waitDeadline) throw error;
      }
      await pauseFor(Math.max(0, Math.min(50, waitDeadline - now())));
    }
    const exception = lastEvaluationError instanceof Error
      ? includeExpression ? `; last evaluation failed: ${lastEvaluationError.message}` : '; last page evaluation did not complete'
      : '';
    const expressionDetail = includeExpression ? `; expression: ${expression.slice(0, 200)}` : '';
    let capture = '';
    if (captureTimeout) {
      try { capture = await captureTimeout(currentLabel()); }
      catch { capture = '; page-step capture unavailable'; }
    }
    throw new Error(`Browser condition "${currentLabel()}" did not arrive within ${timeoutMs}ms${expressionDetail}${exception}${capture}.`);
  };
}

/** Keep the most recent diagnostic bytes while continuously draining Chrome's stderr pipe. */
function appendStderr(current, chunk) {
  const next = current + chunk;
  return next.length <= STDERR_LIMIT ? next : next.slice(-STDERR_LIMIT);
}

/** Describe launch state before cleanup changes whether the Chrome leader is still alive. */
function chromeStartupState(profile, launched) {
  const child = launched?.child;
  const leader = !child ? 'not started'
    : child.exitCode !== null ? `exited (code ${child.exitCode})`
      : child.signalCode !== null ? `exited (signal ${child.signalCode})` : 'still alive';
  const port = existsSync(join(profile, 'DevToolsActivePort')) ? 'present' : 'absent';
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']
    .filter((name) => {
      try { lstatSync(join(profile, name)); return true; }
      catch { return false; }
    });
  const profileLock = locks.length ? `present (${locks.join(', ')})` : 'absent';
  return `leader ${leader}; DevToolsActivePort ${port}; profile lock ${profileLock}; elapsed ${launched?.launchDurationMs ?? 0}ms; load average ${JSON.stringify(loadavg())}`;
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
  // Crash reporters/updaters may inherit stderr outside Chrome's detached group.
  // Once every owned process is gone, stop owning that pipe rather than their lifetime.
  child.stderr?.destroy();
  if (!await waitForLeaderExit(stopped, timeoutMs)) throw new Error('Isolated Chrome did not close after its process group exited.');
}

/**
 * Refuse a Chrome launch from a test file that did not declare a browser [C7]. The runner marks each file's
 * worker held when its first line is `// pullboard: browser` and none otherwise; a launch under none fails
 * here BROWSER_UNDECLARED by file name before Chrome starts. packages/gate/src/io/browser/guard.js
 * also refuses direct browser spawns it can see under none, best effort. Outside the runner this is inert.
 */
export function requireBrowserSlot() {
  if (process.env.PULLBOARD_TEST_BROWSER_SLOT === 'none') throw browserSlotRefusal('through apps/cli/tests/fixtures/chrome.js');
}


let runnerAncestor;

/** The environment variable apps/cli/src/io/run/tests.js sets to its own pid for every test it runs (#896). */
export const RUNNER_PID_ENV = 'PULLBOARD_TEST_RUNNER_PID';

/**
 * Find the test runner above this process: the pid apps/cli/src/io/run/tests.js left in this process's environment, kept
 * only while it is a real ancestor of this process. Why not read command lines: ps prints argv without quoting,
 * so no parser tells a runner started with `--import data:…` or a path with spaces from one of its workers (#896).
 * The walk reads parent pids only, which macOS and Linux both print; no runner, or a stale pid from another tree,
 * answers null, and only the owner is guarded.
 *
 * @param {{ env?: NodeJS.ProcessEnv, parentOf?: (pid: number) => number | null }} [options]
 * @returns {number | null}
 */
export function findRunnerAncestor({ env = process.env, parentOf = parentPid } = {}) {
  if (env === process.env && runnerAncestor !== undefined) return runnerAncestor;
  let found = null;
  const runner = Number(env[RUNNER_PID_ENV]);
  if (Number.isSafeInteger(runner) && runner > 1) {
    let pid = process.pid;
    for (let depth = 0; depth < 64 && pid > 1; depth += 1) {
      pid = parentOf(pid);
      if (pid === null) break;
      if (pid === runner) { found = runner; break; }
    }
  }
  if (env === process.env) runnerAncestor = found;
  return found;
}

/** A process's parent pid from ps, or null when it cannot be read. */
function parentPid(pid) {
  try {
    const value = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; /* An ended process has no parent to read. */ }
}

/**
 * Tie a detached Chrome process group to the processes that own it [C7].
 * A SIGKILLed owner runs no cleanup, so the group would outlive it for days; this starts a tiny detached
 * guardian that kills the group within about a second of the owner, or the runner above it, disappearing.
 * The group leader's pid is the group id.
 */
export function guardChromeGroup(groupId, { ownerPid = process.pid, profile = '' } = {}) {
  if (process.platform === 'win32' || !Number.isSafeInteger(groupId) || groupId <= 1) return null;
  const watched = [ownerPid, findRunnerAncestor()].filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  const guardian = spawnGuardian(process.execPath, ['-e', CHROME_GUARDIAN_SOURCE, String(groupId), profile, new URL('./chrome/shutdown.js', import.meta.url).href, chromeLeaderIdentity(groupId) ?? '', ...watched.map(String)],
    { detached: true, stdio: 'ignore' });
  guardian.on('error', () => {});
  guardian.unref();
  return guardian.pid ?? null;
}

/** Launch an executable as a detached process group and retain its stderr and launch timing. */
export function launchChromeProcess({ executable, args = [], env = process.env, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS } = {}) {
  requireBrowserSlot();
  if (!executable) throw new Error('Chrome was not found; install Chrome or set PULLBOARD_CHROME.');
  const launchedAt = Date.now();
  // Chrome drops com.google.Chrome* folders in its TMPDIR; a private one per launch goes away with it, so none outlive the run [C7].
  const scratch = env.TMPDIR ? null : privateFixtureFiles('pullboard-chrome-tmp-').root;
  const child = spawn(executable, args, { detached: true, env: scratch ? { ...env, TMPDIR: scratch } : env, stdio: ['ignore', 'ignore', 'pipe'] });
  if (child.pid) guardChromeGroup(child.pid, { profile: args.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) });
  let stderr = '';
  let launchError = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = appendStderr(stderr, chunk); });
  child.once('error', (error) => { launchError = error; });
  const stopped = new Promise((resolveStopped) => child.once('close', resolveStopped));
  let closePromise;
  /** Stop this exact process group once; callers can inspect stderr and elapsed launch time. */
  function close() {
    closePromise ??= (async () => {
      const profile = args.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      await quitOwnedChrome(child, profile, stopped, Math.min(3000, cleanupTimeoutMs));
      await stopProcessGroup(child, stopped, cleanupTimeoutMs);
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    })();
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
  taskTimeoutMs = 25_000,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  capturePageSteps = false,
  diagnosticTimeoutMs = 750,
  env = process.env,
} = {}) {
  requireBrowserSlot();
  if (!executable) throw new Error('Chrome was not found; install Chrome or set PULLBOARD_CHROME.');
  const ownedProfile = !profileDirectory;
  const profile = resolve(profileDirectory ?? mkdtempSync(join(tmpdir(), 'pullboard-chrome-')));
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);
  const args = chromeLaunchArgs(profile);
  let launched;
  let socket;
  let loopDelay;
  let id = 0;
  const pending = new Map();
  try {
    launched = launchChromeProcess({ executable, args, env, cleanupTimeoutMs });
    const deadline = Date.now() + startupTimeoutMs;
    const port = await readDevToolsPort(profile, launched, deadline);
    const target = await createPageTarget(port, deadline);
    socket = await connectDevTools(target.webSocketDebuggerUrl, deadline);
    loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const relayRequests = new Set();
    const pageFetches = capturePageSteps ? new Map() : null;
    const send = createSender(socket, pending, () => ++id, commandTimeoutMs, loopDelay, relayRequests, {}, pageFetches);
    const rawEvaluate = createEvaluator(send);
    /** Capture bounded page metadata after a timeout without changing the original operation's deadline. */
    async function capturePageState(label) {
      let page = { readyState: 'unavailable', lastDeviceKeyStep: 'unavailable', storageOpenState: 'unavailable', approvalCard: null };
      const approvalRequestId = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/iu.exec(String(label))?.[1] ?? null;
      if (approvalRequestId) page.approvalCard = { requestId: approvalRequestId, state: 'unavailable', actionCount: 0 };
      try {
        page = await rawEvaluate(`({ readyState: document.readyState,
          lastDeviceKeyStep: window.__pullboardPageStepCapture?.lastDeviceKeyStep ?? 'not observed',
          storageOpenState: window.__pullboardPageStepCapture?.storageOpenState ?? 'not observed',
          approvalCard: ${JSON.stringify(approvalRequestId)} === null ? null : (() => {
            const card = document.querySelector('.phone-approval[data-request="' + ${JSON.stringify(approvalRequestId)} + '"]');
            return { requestId: ${JSON.stringify(approvalRequestId)}, state: card ? 'present' : 'absent', actionCount: card?.querySelectorAll('button').length ?? 0 };
          })() })`,
        'capture page state after timeout', Math.max(1, Math.min(750, diagnosticTimeoutMs, commandTimeoutMs)));
      } catch { /* A page that cannot answer diagnostics still gets a named timeout. */ }
      const pendingFetches = [...pageFetches.values()].map((request) => ({
        method: request.method,
        path: request.path,
        ageMs: Math.max(0, Date.now() - request.startedAt),
      }));
      const stage = String(label).replace(/[\r\n\t]/gu, ' ').slice(0, 120);
      return `; page-step capture: ${JSON.stringify({ stage, ...page, pendingFetches })}`;
    }
    const evaluate = capturePageSteps ? createPageStepEvaluator(rawEvaluate, capturePageState) : rawEvaluate;
    let closed = false;
    let taskSequence = 0;
    /** Navigate the existing isolated browser profile to a local or test-owned URL. */
    async function navigate(nextUrl) {
      await send('Page.navigate', { url: nextUrl }, 'navigate page');
    }
    const waitFor = createWaiter(evaluate, {
      commandTimeoutMs,
      includeExpression: !capturePageSteps,
      ...(capturePageSteps ? { captureTimeout: capturePageState } : {}),
    });
    /** Wait for non-stream relay traffic to finish before an idle-network assertion. */
    async function waitForRelayIdle(timeoutMs = commandTimeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let quietSince = null;
      while (Date.now() < deadline) {
        if (relayRequests.size === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= 100) return;
        } else quietSince = null;
        await pause(20);
      }
      throw new Error(`Relay requests did not become idle within ${timeoutMs}ms.`);
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
    async function pollTask(taskId, timeoutMs = taskTimeoutMs, label = 'poll page operation') {
      const key = JSON.stringify(taskId);
      const deadline = Date.now() + timeoutMs;
      await waitFor(`window[${key}] !== null && window[${key}] !== undefined`, timeoutMs, label);
      const result = await evaluate(`window[${key}]`, label + ' result', deadline - Date.now());
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
    await send('Network.enable', {}, 'enable network diagnostics', deadline - Date.now());
    await send('Page.enable', {}, 'enable page diagnostics', deadline - Date.now());
    await send('Runtime.enable', {}, 'enable runtime diagnostics', deadline - Date.now());
    if (capturePageSteps) await send('Page.addScriptToEvaluateOnNewDocument', { source: pageStepCaptureScript() }, 'install page-step capture', deadline - Date.now());
    await send('Page.navigate', { url }, 'open initial page', deadline - Date.now());
    const launchDurationMs = launched.launchDurationMs;
    process.stderr.write(`Chrome ready in ${launchDurationMs}ms (${startupTimeoutMs}ms DevTools budget)\n`);
    return {
      profileDirectory: profile,
      launchDurationMs,
      get stderr() { return launched.stderr; },
      navigate,
      evaluate,
      waitFor,
      waitForRelayIdle,
      startTask,
      pollTask,
      send,
      close,
    };
  } catch (error) {
    loopDelay?.disable();
    socket?.close();
    rejectPending(pending, 'Isolated Chrome stopped before startup completed.');
    const launchDurationMs = launched?.launchDurationMs ?? 0;
    const stderr = launched?.stderr?.trimEnd();
    const startupState = chromeStartupState(profile, launched);
    let cleanupFailure = null;
    try { await launched?.close(); }
    catch (cleanupError) { cleanupFailure = cleanupError; }
    if (!cleanupFailure && ownedProfile) rmSync(profile, { recursive: true, force: true });
    const message = sanitizeStartupError(error);
    const cleanup = cleanupFailure ? `\n${cleanupFailure.message}; profile retained until the process group exits` : '';
    throw new Error(`${message.message} (elapsed ${launchDurationMs}ms; ${startupTimeoutMs}ms DevTools budget)\nChrome startup state: ${startupState}${stderr ? `\nChrome stderr:\n${stderr}` : ''}${cleanup}`);
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

/** Create a CDP sender with a deadline checked on the same clock used by timeout diagnostics. */
export function createSender(socket, pending, nextId, timeoutMs, loopDelay, relayRequests, timers = {}, pageFetches = null) {
  const now = timers.now ?? Date.now;
  const schedule = timers.setTimeout ?? setTimeout;
  const cancel = timers.clearTimeout ?? clearTimeout;
  let mainFrameNavigation = 0;
  let mainFrameId;
  let mainFrameNavigationEvent = 'none';
  let terminalError = null;
  /** Reject in-flight commands once the target or its DevTools transport is gone. */
  function failPending(reason, code = 'CDP_TARGET_CLOSED') {
    if (terminalError) return;
    terminalError = { reason, code };
    for (const [requestId, waiter] of pending) {
      pending.delete(requestId);
      cancel(waiter.timer);
      const error = new Error(`DevTools command failed: ${waiter.method} "${waiter.label}"; ${reason}.`);
      error.code = code;
      error.navigated = false;
      waiter.reject(error);
    }
  }
  /** Resolve or reject the request matching one CDP response without logging its payload. */
  function onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.method === 'Inspector.detached') {
      failPending(`DevTools target detached${message.params?.reason ? `: ${message.params.reason}` : ''}`);
      return;
    }
    if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
      mainFrameId = message.params.frame.id;
      mainFrameNavigation += 1;
      mainFrameNavigationEvent = 'Page.frameNavigated';
      relayRequests.clear();
    }
    if (message.method === 'Page.frameStartedNavigating' && message.params?.frameId === mainFrameId) {
      mainFrameNavigation += 1;
      mainFrameNavigationEvent = 'Page.frameStartedNavigating';
    }
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params?.request;
      const url = request?.url ?? '';
      if (pageFetches && ['Fetch', 'XHR'].includes(message.params?.type)) {
        let path = '/';
        try {
          path = new URL(url).pathname.split('/').map((segment) => {
            if (!segment) return '';
            return new Set(['api', 'auth', 'boards', 'devices', 'approvals', 'enrollments', 'start', 'state', 'events', 'requests', 'authorize', 'github', 'session', 'tokens', 'machines']).has(segment)
              || /^v[0-9]{1,3}$/u.test(segment)
              ? segment : ':id';
          }).join('/');
        } catch { path = '/[unavailable]'; }
          pageFetches.set(message.params.requestId, {
            method: /^[A-Za-z]{1,12}$/u.test(request?.method ?? '') ? request.method.toUpperCase() : 'OTHER',
            path: path.slice(0, 160),
            startedAt: now(),
          });
          while (pageFetches.size > 32) pageFetches.delete(pageFetches.keys().next().value);
      }
      const eventStream = /\/api\/v1\/boards\/[0-9a-f]{32}\/events(?:\?|$)/.test(url)
        && /text\/event-stream/i.test(request?.headers?.Accept ?? request?.headers?.accept ?? '');
      if (/\/api\/v1\/boards\//.test(url) && !eventStream) relayRequests.add(message.params.requestId);
    }
    if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
      relayRequests.delete(message.params?.requestId);
      pageFetches?.delete(message.params?.requestId);
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    cancel(waiter.timer);
    if (message.error) {
      const cdpError = message.error;
      const navigated = mainFrameNavigation !== waiter.mainFrameNavigationAtSend;
      const navigation = navigated ? `yes (${mainFrameNavigationEvent})` : 'no';
      const error = new Error(`DevTools command failed: ${waiter.method} "${waiter.label}"; CDP error ${cdpError.code}: ${cdpError.message}; page navigated since command was sent: ${navigation}.`);
      error.code = cdpError.code;
      error.navigated = navigated;
      waiter.reject(error);
    } else waiter.resolve(message.result);
  }
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', (event) => {
    const detail = Number.isInteger(event?.code) ? `DevTools socket closed (code ${event.code})` : 'DevTools socket closed';
    failPending(detail);
  });
  socket.addEventListener('error', () => failPending('DevTools socket failed'));
  return (method, params = {}, label = method, remainingMs = timeoutMs) => new Promise((resolveResult, rejectResult) => {
    if (terminalError) {
      const error = new Error(`DevTools command failed: ${method} "${label}"; ${terminalError.reason}.`);
      error.code = terminalError.code;
      error.navigated = false;
      rejectResult(error);
      return;
    }
    const requestId = nextId();
    const startedAt = now();
    const durationMs = Math.max(1, Math.min(timeoutMs, remainingMs));
    const deadline = startedAt + durationMs;
    const maxDelayAtSend = loopDelay.max;
    /** Format the timeout using the elapsed value already checked against this command deadline. */
    const timeoutMessage = elapsedMs => {
      const maxDelayRise = Math.max(0, loopDelay.max - maxDelayAtSend);
      return `DevTools ${method} "${label}" timed out after ${elapsedMs}ms; maximum event-loop delay ${Math.round(maxDelayRise / 1e6)}ms; relay request pending: ${relayRequests.size > 0}.`;
    };
    let timer;
    /** Re-arm an early callback so timeout reporting cannot precede the armed deadline. */
    const expire = () => {
      if (!pending.has(requestId)) return;
      const currentTime = now();
      const elapsedMs = currentTime - startedAt;
      const remaining = deadline - currentTime;
      if (remaining > 0) {
        timer = schedule(expire, remaining);
        pending.get(requestId).timer = timer;
        return;
      }
      pending.delete(requestId);
      const error = new Error(timeoutMessage(elapsedMs));
      error.code = 'CDP_TIMEOUT';
      rejectResult(error);
    };
    timer = schedule(expire, durationMs);
    pending.set(requestId, { resolve: resolveResult, reject: rejectResult, timer, method, label, mainFrameNavigationAtSend: mainFrameNavigation });
    try { socket.send(JSON.stringify({ id: requestId, method, params })); }
    catch {
      cancel(timer);
      pending.delete(requestId);
      rejectResult(new Error(`DevTools command could not be sent: ${method}.`));
    }
  });
}

/** Evaluate a page expression by value and retain bounded diagnostics for page exceptions. */
export function createEvaluator(send) {
  return async (expression, label = 'evaluate page expression', remainingMs) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, label, remainingMs);
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

/** Add bounded page-state capture to evaluation timeouts while preserving the original failure. */
export function createPageStepEvaluator(evaluate, captureTimeout) {
  return async (expression, label = 'evaluate page expression', remainingMs) => {
    try { return await evaluate(expression, label, remainingMs); }
    catch (error) {
      if (error?.code !== 'CDP_TIMEOUT') throw error;
      try { error.message += await captureTimeout(label); }
      catch { error.message += '; page-step capture unavailable'; }
      throw error;
    }
  };
}

/** Instrument only bounded operation names so a timeout can distinguish crypto and storage stages. */
function pageStepCaptureScript() {
  return `(() => {
    const state = window.__pullboardPageStepCapture = { lastDeviceKeyStep: 'no device-key operation observed', storageOpenState: 'not opened' };
    try {
      const prototype = Object.getPrototypeOf(indexedDB);
      const originalOpen = prototype.open;
      prototype.open = function (...args) {
        state.storageOpenState = 'opening';
        const request = originalOpen.apply(this, args);
        request.addEventListener('success', () => { state.storageOpenState = 'open'; }, { once: true });
        request.addEventListener('error', () => { state.storageOpenState = 'failed'; }, { once: true });
        request.addEventListener('blocked', () => { state.storageOpenState = 'blocked'; }, { once: true });
        return request;
      };
    } catch {}
    try {
      const prototype = Object.getPrototypeOf(crypto.subtle);
      for (const name of ['generateKey', 'importKey', 'deriveBits', 'deriveKey', 'encrypt', 'decrypt', 'sign', 'verify', 'exportKey']) {
        const original = prototype[name];
        if (typeof original !== 'function') continue;
        prototype[name] = function (...args) {
          state.lastDeviceKeyStep = 'crypto.subtle.' + name + ' started';
          return original.apply(this, args);
        };
      }
    } catch {}
  })();`;
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
